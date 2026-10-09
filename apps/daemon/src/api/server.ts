/**
 * The HTTP surface: the SPA, the operator and automation, one origin and one port.
 *
 * **The API is the only way to change anything.** The interface is a client with no privileges
 * of its own, which keeps automation a first-class path rather than an afterthought.
 *
 * One gate that is enforced here and is easy to get wrong:
 *
 * * **The machine API is off by default.** A bearer token is rejected until somebody on the device
 *   runs `way machine-api on`, even if the token exists and is valid — and the refusal says so.
 *
 * There used to be a second: a setup gate that refused every route until the shipped default
 * password had been replaced. It is gone, deliberately — see `docs/10-security.md`, *The default
 * password is short, by decision*. What replaces it is nothing: the default is a default and not a
 * mode, and `setupComplete` below is now a **fact reported**, not a permission checked.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { watchSerialiserLoss } from './serialiser-loss.ts';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  ALL_SCHEMAS,
  ChangePasswordRequest,
  CreateTokenRequest,
  CreateTokenResponse,
  DebugLevelRequest,
  DebugLevelResponse,
  ErrorResponse,
  EventLogQuery,
  EventLogResponse,
  HealthResponse,
  InventoryResponse,
  LoginRequest,
  LoginResponse,
  LogsQuery,
  LogsResponse,
  PowerOffRequest,
  PowerOffResponse,
  ProfileInvalidError,
  StatusResponse,
  DriftResponse,
  ObserversResponse,
  RuleSetAgesResponse,
  type RuleSetAgeSchema,
  SystemResponse,
  TokenSummary,
  TunnelRestartResponse,
} from '@wayfarer/schemas';
import type { Platform } from '../platform/index.ts';
import type { Store, TokenScope } from '../state/store.ts';
import { ProfileUnreadableError } from '../state/profiles.ts';
import { summarise, type DriftReport } from '../core/drift.ts';
import type { ObserverReport } from '../core/observers.ts';
import { readStamp, type MonotonicStamp } from '../core/credential-expiry.ts';
import { windowCountdown } from '../core/transactions.ts';
import { collectFleet, duplicateIdentities } from '../core/fleet.ts';
import { describeCapabilities } from '../core/capabilities.ts';
import { bindingCandidates } from '../core/binding.ts';
import type { Telemetry } from '../telemetry/index.ts';
import type { ManagementChannels } from './bind-policy.ts';
import { collectInventory, type Inventory } from '../inventory/index.ts';
import type { DaemonConfig } from '../config.ts';
import { SCHEMA_VERSION } from '../state/migrations.ts';
import { registerProfileRoutes, type ProfileRoutesContext } from './profiles-routes.ts';
import { RouteAccessIndex, enrichedOpenapi, renderApiDocs, viewOf } from './docs.ts';

export const SESSION_COOKIE = 'wayfarer_session';

export interface ServerContext {
  config: DaemonConfig;
  /**
   * The last comparison of the stored profile with what this device is actually doing.
   *
   * A function rather than a value, so the answer is the current one rather than the one that held
   * when the server was built — the check runs at boot, after every revert and on its own cadence,
   * and a captured report would go stale in exactly the way the check exists to detect.
   *
   * Optional for the same reason `profileRoutes` is: a server must be constructible on a device whose
   * profile machinery cannot start. Absent reaches the client as `report: null`, which the schema
   * declares as "nobody has looked yet" and never as "nothing diverged".
   */
  drift?: () =>
    | { report: DriftReport | null; ageSeconds: number | null }
    | Promise<{ report: DriftReport | null; ageSeconds: number | null }>;
  /**
   * Every mechanism that watches or waits for something in the world, read at request time.
   *
   * **Required.** An optional reader defaulting to an empty list would serve "nothing is watching"
   * and "everything is fine" as the same empty screen, which is the exact confusion it exists to end.
   */
  observers: () => ObserverReport[];
  /**
   * How old this device's copy of each rule set in use is, **and which profile that is about**.
   *
   * A call rather than a stored value: the answer changes whenever the core refreshes a list, and a
   * figure captured when the server was built is the stale reading this route exists to expose.
   *
   * **Required, not optional.** It was optional, defaulting to an empty list, which is a dependency
   * defaulting to silence: a caller that forgets it serves a panel with nothing in it and no error,
   * and nothing distinguishes that from a device with no rule sets. The same argument was already
   * made two files along for the drift reader and then not applied here. A server that cannot answer
   * this must say so by failing to compile.
   */
  ruleSetAges: () => Promise<{ profileId: string | null; sets: RuleSetAgeSchema[] }>;
  platform: Platform;
  store: Store;
  telemetry: Telemetry;
  startedAt: Date;
  version: string;
  buildAt: string | null;
  /** Interfaces from the configuration that resolved to no address at bind time. */
  unresolvedInterfaces: string[];
  /**
   * Addresses the daemon is listening on right now, which is not the same as the configured list:
   * an interface name resolves to whatever the kernel reports, and a configured address can fail to
   * bind. Reporting the configuration instead of the reality is how an interface says it is
   * reachable somewhere it is not.
   */
  boundAddresses: string[];
  /**
   * The management channels as the bind policy last decided them, or null before the first reading.
   *
   * Null is a real answer and not an empty report: "we have not decided yet" and "nothing was
   * refused" are different facts, and only one of them means nobody needs to look. A caller that
   * turned the first into the second would recreate the defect this field exists to end.
   *
   * Optional for the reason `profileRoutes` is: a server must be constructible without the bind
   * policy having run, and absent reaches the client as null rather than as an empty list — same
   * distinction, one level out.
   */
  managementChannels?: () => ManagementChannels | null;
  configWarnings: string[];
  /** Raises the log level for a bounded period; returns when it reverts. */
  setLogLevel(level: string, minutes: number): { level: string; revertsAt: string | null };
  currentLogLevel(): string;
  /**
   * Everything the profile, plan and apply routes need. Optional so a server can be built without
   * them — the log surfaces and the status view must keep working on a device whose profile machinery
   * cannot start, which is the whole availability argument of this design.
   */
  profileRoutes?: Omit<ProfileRoutesContext, 'requireScope'>;
  /**
   * How long after answering `POST /api/system/poweroff` the power-off is asked for. Defaults to
   * `POWER_OFF_DELAY_MS`; a test shortens it so it can watch both sides of the delay.
   */
  powerOffDelayMs?: number;
}

/**
 * The pause between the 202 and the power-off.
 *
 * Long enough for a phone on the access point to receive a reply of a few hundred bytes — the access
 * point is one of the things that goes — and short enough that nobody reads the screen, decides it did
 * not work, and pulls the plug on a card mid-shutdown. [assumption: chosen, not measured]
 */
export const POWER_OFF_DELAY_MS = 3_000;

interface Authenticated {
  kind: 'session' | 'token';
  scopes: TokenScope[];
  /**
   * The session id or token id. Carried so a transaction can record which credential opened it, which
   * is the whole basis of the narrow expiry exemption in `core/credential-expiry.ts`.
   */
  id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Authenticated;
  }
  interface FastifyInstance {
    /** Every route this server registered, with the scope it enforces. See the decoration below. */
    wayfarerRouteAccess: RouteAccessIndex;
  }
}

/**
 * Named once, because it appears in the routes, in every refusal body and in the interface.
 *
 * Declared above the two sets below rather than beside the route, because both of them name it and
 * a `const` read before its declaration is a daemon that does not start.
 */
export const DOCS_PATH = '/api/docs';

/**
 * Routes any authenticated credential reaches, with no scope checked.
 *
 * This set was `SETUP_EXEMPT` — the exception list of the forced-credential-change gate. The gate
 * is gone (E16), but the set is not the gate and deleting it would have been a mistake: it is also
 * what tells the build-time check below that these four routes have **no scope guard on purpose**.
 * Renamed rather than removed, so it now says what it does. A logout or a password change cannot
 * require a scope, because the credential presenting itself is the operator's own session and
 * sessions carry every scope by construction — requiring one would be a check that can never fail.
 */
const UNSCOPED_ROUTES = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/password',
  // See the note on the route itself: it describes shapes, never data, and it is what every 401 and
  // 404 hands the caller. A documentation link that answers 401 is a wall with a signpost on it.
  DOCS_PATH,
]);

/** Routes reachable with no authentication at all. */
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/login', DOCS_PATH]);

/**
 * The lockout window, in **seconds of uptime** rather than milliseconds of wall clock.
 *
 * The unit changed with the frame. Attempts are compared by the board's uptime within one boot, which
 * is monotonic and immune to any clock step; across boots an attempt's age is unknown and it takes no
 * part in the decision. See `core/credential-expiry.ts` for the trade that implies.
 */
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES = 10;

export async function buildServer(context: ServerContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Per-request logging is off: at 200 MB of RAM-backed journal, a request log is the fastest
    // way to evict the lines that mattered. The debug switch turns it on for a bounded period.
    // `logger: false` already means no request log; the separate disableRequestLogging option is
    // deprecated in Fastify 5 and prints a deprecation warning into the journal on every start.
    logger: false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Every test that makes a request checks that the response schema dropped nothing the handler
  // produced — see `serialiser-loss.ts` for the field that reached no screen on 2026-09-24.
  if (process.env['WAYFARER_SERIALISER_CHECK'] === '1') {
    watchSerialiserLoss(app, (route, paths) =>
      JSON.stringify({
        error: {
          code: 'response_schema_dropped_fields',
          message: `${route}: the response schema dropped ${paths.slice(0, 10).join(', ')}`,
          hint: 'Declare the field in the route response schema, or stop producing it.',
        },
      }),
    );
  }

  for (const schema of ALL_SCHEMAS) {
    if (typeof schema === 'object' && schema !== null && '$id' in schema && schema.$id) {
      app.addSchema(schema);
    }
  }

  await app.register(fastifyCookie);
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Wayfarer',
        description:
          'Control plane for a tunnelling router. Generated from the same schemas the daemon ' +
          'validates with, so it cannot fall out of date.',
        version: context.version,
      },
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
          bearer: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  });

  app.setErrorHandler((rawError: unknown, request, reply) => {
    /*
     * A stored document this build cannot bring forward is answered here rather than at each route.
     *
     * It is raised on the **read** path — migration is lazy — so it can come out of any handler that
     * touches a profile, including ones written later that have never heard of it. Mapping it at the
     * seam every reply passes through is the same argument as the 404 link below: a rule that has to
     * be remembered at five call sites is not a rule. 409 rather than 500, because nothing failed:
     * the device is holding a configuration this build does not run, and the reply says which one.
     */
    /*
     * A write refused by the profile schema, answered at the same seam and for the same reason.
     *
     * The gate is inside the store, which is the one door every write goes through — three routes
     * today, and `import` reaches it through `create`. Answering it here rather than at each route
     * is what makes that true of a route written later as well.
     */
    if (rawError instanceof ProfileInvalidError) {
      const first = rawError.faults[0];
      void reply.status(400).send({
        error: {
          code: first?.code ?? 'invalid_request',
          message: first?.message ?? rawError.message,
          ...(first?.pointer === undefined ? {} : { pointer: first.pointer }),
          ...(first?.hint === undefined ? {} : { hint: first.hint }),
          detail: { faults: rawError.faults },
        },
      });
      return;
    }

    if (rawError instanceof ProfileUnreadableError) {
      void reply.status(409).send({
        error: {
          code: rawError.fault.code,
          message: rawError.fault.message,
          hint: rawError.fault.hint,
          detail: { profileId: rawError.profileId, name: rawError.profileName, ...(rawError.fault.detail ?? {}) },
        },
      });
      return;
    }

    // Fastify types the handler's error as unknown under a strict configuration, and it can in
    // fact be anything a route threw — including a value that is not an Error at all.
    const error = rawError as { statusCode?: number; message?: string; validation?: { instancePath?: string }[] };
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    // Validation failures carry a JSON Pointer so the interface can put the message on the
    // field rather than matching on text.
    const pointer = error.validation?.[0]?.instancePath;
    void reply.status(status).send({
      error: {
        code: status === 400 ? 'invalid_request' : status === 404 ? 'not_found' : 'internal_error',
        message: typeof error.message === 'string' ? error.message : String(rawError),
        ...(pointer ? { pointer } : {}),
      },
    });
  });

  /*
   * Every refusal that means *you asked for something that is not there* names the documentation,
   * as a link — E9.
   *
   * Done in one `onSend` hook rather than at each place that answers, and that is the whole
   * decision. There are five such places today (this handler, the error handler, a missing token, a
   * missing profile, a missing transaction) and the next one will be written by somebody who has
   * never read this comment. A rule applied at the seam every response already passes through
   * cannot be forgotten by a route that does not know it exists; a rule that has to be remembered
   * is not a rule, it is a hope. Same argument as the `hostapd_cli` wrapper: a warning that can be
   * ignored is weaker than a mechanism that cannot be bypassed.
   *
   * ## Two conditions were wrong, and each cut off exactly the caller the link is for
   *
   * **`401` as well as `404`.** The authentication gate is an `onRequest` hook, so it fires *before
   * routing*: an unauthenticated `GET /api/no-such-thing` never reaches the not-found handler and
   * answered `401 {"code":"unauthenticated","hint":"POST /api/auth/login"}` with no link at all. A
   * person who has mistyped a path and has not logged in is the most likely reader of a
   * documentation link there is, and they were the one caller who could not be given one. The 401's
   * own hint is kept and the link is added to it rather than replacing it: how to log in is still
   * the first thing they need.
   *
   * **Not only under `/api/`.** The early return on the path meant `GET /nope` answered
   * `404 {"code":"no_interface"}` with nothing. The condition that matters is not where the request
   * went, it is whether the body is already the documented error envelope — which the parse and the
   * `error` check below decide. A static file, an HTML page and the interface's own routing are all
   * excluded by those two, and they are excluded for the right reason.
   *
   * It only ever *adds*. A refusal that carries its own hint keeps it.
   */
  const LINKED_STATUSES = new Set([401, 404]);
  app.addHook('onSend', async (request, reply, payload) => {
    if (!LINKED_STATUSES.has(reply.statusCode)) return payload;
    if (typeof payload !== 'string') return payload;
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      // A body that is not JSON is the interface's own routing or a static file. Untouched:
      // rewriting a body we did not shape is how a hook breaks something it never meant to see.
      return payload;
    }
    const error = (body as { error?: Record<string, unknown> } | null)?.error;
    if (typeof error !== 'object' || error === null) return payload;
    // Built from the request so the link is one the caller can actually follow — a relative path is
    // not a link in a terminal, which is where most of these are read.
    const origin = `${request.protocol}://${request.headers.host ?? 'this-device'}`;
    const link = `${origin}${DOCS_PATH}`;
    const documented = `every endpoint this daemon serves is documented at ${link}`;
    const existing = error['hint'];
    error['hint'] =
      typeof existing === 'string' && existing !== '' ? `${existing.replace(/\.$/, '')}. ${documented}` : documented;
    const detail = typeof error['detail'] === 'object' && error['detail'] !== null ? error['detail'] : {};
    error['detail'] = { ...(detail as Record<string, unknown>), documentation: link };
    return JSON.stringify(body);
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({
        error: { code: 'not_found', message: `no route for ${request.method} ${request.url}` },
      });
    }
    // Anything else is the single-page application's own routing.
    if (context.config.uiDir !== null) return reply.sendFile('index.html');
    return reply.status(404).send({ error: { code: 'no_interface', message: 'no interface is installed' } });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const path = request.url.split('?')[0] ?? request.url;

    const auth = await authenticate(request, context);
    if (auth !== null && auth.kind !== 'machine-access-off') request.auth = auth;

    if (!PUBLIC_ROUTES.has(path) && auth?.kind === 'machine-access-off') {
      /*
       * **The one obstacle is the device's switch, so the refusal names the switch.**
       *
       * It used to answer `401 unauthenticated, "log in first"` — true of nothing here: the token is
       * valid and unexpired, and logging in would not help a script. The holder was told to do the one
       * thing that cannot work and had no way to learn what would (`docs/13-plan.md` row F8). Still
       * refused, because machine access off by default is the right default; only the sentence changed.
       *
       * Where the switch is had to be *made* true before it could be said: nothing in the interface or
       * the CLI turned it on, so the only way was to edit the database by hand. `way machine-api on`
       * now exists for that, run on the device by someone who can already log in to it.
       */
      return reply.status(403).send({
        error: {
          code: 'machine_access_off',
          message:
            'this token is valid, but machine access to this device is turned off, so no token is accepted ' +
            'until it is turned on. Logging in would not help: a browser session is not refused by this.',
          hint: 'On the device, run `way machine-api on` (as root), then repeat the request. `way machine-api status` shows the current setting.',
          detail: { tokenScopes: auth.scopes, switch: 'device.api_enabled', turnOn: 'way machine-api on' },
        },
      });
    }

    if (!PUBLIC_ROUTES.has(path) && !auth) {
      return reply.status(401).send({
        error: { code: 'unauthenticated', message: 'log in first', hint: 'POST /api/auth/login' },
      });
    }

    /*
     * Nothing else is checked here.
     *
     * A `setup_incomplete` refusal used to stand at this point: until the shipped default password
     * had been replaced, every route but four answered 403. It was removed for E16 and the removal
     * is the task, not a side effect of it — `docs/10-security.md` records the owner's decision and
     * the exposure it accepts. Left as a comment rather than deleted silently, because a gate that
     * vanishes without a trace is the kind of thing somebody re-adds as an obvious improvement.
     */
    return undefined;
  });

  // Refuse to build a server with an unguarded route. A scope missed on one read route is exactly
  // how the first version of this file ended up ignoring scopes entirely, and a hook cannot catch
  // it because a hook does not know what the route needed.
  const accessIndex = new RouteAccessIndex();
  const unguarded: string[] = [];
  app.addHook('onRoute', (route) => {
    const url = route.url;
    if (!url.startsWith('/api/')) return;
    if (route.method === 'HEAD') return;

    const handlers = ([] as unknown[]).concat(route.preHandler ?? []);
    const guard = handlers.find(
      (handler): handler is ScopeGuard => typeof handler === 'function' && 'wayfarerScope' in handler,
    );

    /*
     * The same walk feeds two consumers, and that is the point rather than a convenience.
     *
     * The scope a route requires lives in this guard object and nowhere else — not in the schema,
     * which is what `@fastify/swagger` reads. So a document generated purely from schemas is
     * complete, correct, and silent about the single most important fact per endpoint. Reading it
     * back out here means the page and the refusal come from one object: they cannot disagree, and
     * a route added later carries both without anybody remembering to annotate it.
     */
    for (const method of ([] as string[]).concat(route.method as string | string[])) {
      accessIndex.record(
        method,
        url,
        PUBLIC_ROUTES.has(url)
          ? { kind: 'public' }
          : guard
            ? { kind: 'scope', scope: guard.wayfarerScope }
            : { kind: 'authenticated' },
      );
    }

    if (PUBLIC_ROUTES.has(url) || UNSCOPED_ROUTES.has(url)) return;
    if (guard) return;
    unguarded.push(`${String(route.method)} ${url}`);
  });

  registerRoutes(app, context, accessIndex);

  // Registered through the same `requireScope` factory, so the marker the hook above looks for is the
  // same object shape. Passing a different factory here is how the invariant would be lost quietly.
  if (context.profileRoutes) {
    registerProfileRoutes(app, { ...context.profileRoutes, requireScope });
  }

  if (unguarded.length > 0) {
    throw new Error(
      `these API routes have no scope guard, so any authenticated credential would reach them: ${unguarded.join(', ')}`,
    );
  }

  /*
   * The route table, on the instance, as the **second source** a coverage check needs.
   *
   * `RouteAccessIndex.keys()` was commented as existing "for a test that wants to prove the document
   * covers all of them" and no test called it, because there was no way to reach the index from
   * outside. So the coverage check compared `enrichedOpenapi(app, accessIndex)` against
   * `enrichedOpenapi(app, accessIndex)` — the same call on both sides, which proves the renderer
   * drops no rows and says nothing about the route table. Proved by construction: a live route
   * declared `schema: { hide: true }` answered 200, appeared in neither the document nor the page,
   * and the assertion replayed verbatim still passed.
   *
   * This index is filled by the `onRoute` hook, which sees every route registered whatever its
   * schema says, so it is genuinely independent of `@fastify/swagger`'s view of the same server.
   */
  app.decorate('wayfarerRouteAccess', accessIndex);

  if (context.config.uiDir !== null) {
    await app.register(fastifyStatic, {
      root: context.config.uiDir,
      // Pre-compressed assets are served as they are: this CPU should not be compressing on
      // every request for a phone on the local network.
      preCompressed: true,
      index: ['index.html'],
    });
  }

  return app;
}

/**
 * Whether a transaction opened by this exact credential is awaiting confirmation.
 *
 * The one narrow exemption from expiry, and the product rule the rest of the expiry logic serves: an
 * operator must not lose their credentials while a timer is counting down on a change only they can
 * confirm. Losing it there means the change reverts for want of a click nobody could make — and since
 * the apply restarts the time service, a forward clock step inside that window is the designed path.
 *
 * Narrow on purpose. Not "any window is open", which would be a way to keep any credential alive
 * indefinitely by leaving a window open, and not "any credential" — only the one that opened it.
 */
function holdsOpenWindowFor(context: ServerContext): (credentialId: string) => boolean {
  return (credentialId) => {
    // Absent when the profile machinery could not start, in which case there are no transactions and
    // so no window to be inside. No exemption, rather than an exemption that cannot be checked.
    const profiles = context.profileRoutes?.profiles;
    if (!profiles) return false;
    const open = profiles.unconfirmedTransaction();
    return open !== null && open.openedBy !== null && open.openedBy === credentialId;
  };
}

/** A valid token presented while machine access is off: not a credential, but not an unknown one either. */
interface MachineAccessOff {
  kind: 'machine-access-off';
  scopes: TokenScope[];
}

async function authenticate(
  request: FastifyRequest,
  context: ServerContext,
): Promise<Authenticated | MachineAccessOff | null> {
  /*
   * Read once per request, and together. `stamp` is the pair that makes a credential's age both durable
   * and immune to a wall-clock step; `clockTrusted` decides whether an absolute token expiry may be
   * enforced at all. Both are `null` when they cannot be read, and both absences mean "unverifiable"
   * rather than "expired".
   */
  const stamp = await currentStamp(context);
  const clock = await context.platform.clock.status().catch(() => null);
  const check = {
    stamp,
    clockTrusted: clock?.synchronized ?? null,
    holdsOpenWindow: holdsOpenWindowFor(context),
  };

  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    // A valid token is still refused while machine access is off: a fresh device cannot be
    // driven remotely until a human enables it. It is looked up anyway, without recording a use, so
    // the refusal can say which obstacle it is — see the hook above.
    if (!context.store.device().apiEnabled) {
      const peeked = context.store.tokenBySecret(header.slice(7).trim(), check, false);
      if (peeked === null || peeked.verdict.kind === 'expired') return null;
      return { kind: 'machine-access-off', scopes: peeked.token.scopes };
    }
    const found = context.store.tokenBySecret(header.slice(7).trim(), check);
    if (!found) return null;
    if (found.verdict.kind === 'expired') return null;
    if (found.verdict.kind === 'unverifiable') {
      // Honoured, and recorded. A token outliving its stated expiry is worth a line in the log even
      // when honouring it is the right call, because the alternative is a silent extension.
      context.store.recordEvent({
        level: 'warn',
        kind: 'auth.expiry-unverifiable',
        summary: `an API token was accepted without its expiry being checked: ${found.verdict.reason}`,
        detail: { token: found.token.id, reason: found.verdict.reason },
      });
    }
    return { kind: 'token', scopes: found.token.scopes, id: found.token.id };
  }

  const sessionId = request.cookies[SESSION_COOKIE];
  if (typeof sessionId === 'string' && sessionId !== '') {
    const found = context.store.session(sessionId, check);
    if (found && found.verdict.kind !== 'expired') {
      context.store.touchSession(found.session.id, undefined, stamp);
      // A browser session is the operator: full scope. Scope separation exists for tokens,
      // where a leaked credential should not mean full control.
      return { kind: 'session', scopes: ['read', 'apply', 'admin'], id: found.session.id };
    }
  }

  return null;
}

/** Boot identity plus uptime, through the one shared reader. See `core/credential-expiry.ts`. */
async function currentStamp(context: ServerContext): Promise<MonotonicStamp | null> {
  return await readStamp({
    bootId: () => context.platform.journal.currentBootId(),
    uptimeSeconds: () => context.platform.host.uptimeSeconds(),
  });
}

/**
 * Scope enforcement, per route.
 *
 * It is deliberately not done in the global hook: a hook can only prove that *some* credential
 * authenticated, and the first version of this file did exactly that — a token issued with
 * `['apply']` could read the inventory, the live status and both log surfaces, because no read
 * route asked for a scope at all. That contradicted the scope table in docs/07-api.md and removed
 * the mitigation docs/10-security.md claims for a leaked token. Documentation promising a control
 * the code does not implement is worse than no control, because someone relies on it.
 *
 * The guard carries a marker so `assertEveryRouteHasAScope` below can refuse to build a server with
 * an unguarded route. Fail-closed by construction beats remembering.
 */
type ScopeGuard = ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) & {
  wayfarerScope: TokenScope;
};

function requireScope(scope: TokenScope): ScopeGuard {
  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.auth && request.auth.scopes.includes(scope)) return;
    await reply.status(403).send({
      error: {
        code: 'insufficient_scope',
        message: `this route needs the "${scope}" scope`,
        hint: `the credential used carries ${request.auth?.scopes.join(', ') || 'no scopes'}`,
      },
    });
  };
  (guard as ScopeGuard).wayfarerScope = scope;
  return guard as ScopeGuard;
}

/**
 * How long **this process** has been running, in seconds.
 *
 * `process.uptime()` and not `Date.now() - startedAt`, and the distinction is not pedantic: the wall
 * clock on this board is stepped by `systemd-timesyncd` shortly after boot and again on every resync,
 * and the board has no clock battery — so a subtraction of two wall-clock readings reported a daemon
 * minutes old as having run for days, or for a negative time. That number is read by a person asking
 * "did it restart?" and by anything monitoring this device, and both get the wrong answer at exactly
 * the moment something interesting happened.
 *
 * Note this is deliberately *process* uptime, which is what the field means. `process.uptime()` was
 * once reached for to mean **machine** uptime, which it is not; see `platform/host.ts` and the
 * catalogue entry about that mismatch. Both facts are true at once, and the frame is the whole
 * question: name it, and the two stop being confusable.
 */
function daemonUptimeSeconds(): number {
  return Math.round(process.uptime());
}

/**
 * One bounded request to a peer.
 *
 * Bounded twice over — an abort signal and the runtime's own timeout — because the failure this guards
 * against is a peer that accepts the connection and then says nothing, which no connect timeout catches.
 * A hung peer must cost one bounded wait and never the page.
 *
 * Throws on anything that is not an HTTP answer, which is what the caller turns into `unreachable`. A
 * status is an answer even when it is a refusal, and the two are reported differently.
 */
async function fetchPeerJson(
  url: string,
  token: string | null,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    // A body that will not parse is not a reason to call the peer unreachable: it answered.
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** The one body `POST /api/system/poweroff` accepts, spelled once for the check and for every refusal. */
const POWER_OFF_CONFIRMATION = 'poweroff';
const POWER_OFF_BODY = `{"confirm":"${POWER_OFF_CONFIRMATION}"}`;

/**
 * `POST /api/system/poweroff`: switch the whole device off, on request.
 *
 * The owner asked for it, and it is the one route whose success means the device stops answering until
 * somebody is physically next to it. Every guard below is ordered so that **nothing before the
 * confirmation check can reach the power-off or write anything**, which is what makes a refusal to a
 * request with no body a safe way to prove the route exists on a device.
 *
 * * **`admin`**, the scope that already covers every device-wide act (tokens, the password, peers). A
 *   leaked `apply` token can change and confirm a configuration, which the device can undo; it must not
 *   be able to take the device away from everyone until someone walks up to it.
 * * **An explicit confirmation in the body, and nothing else there.** A bare POST, a probing script, a
 *   form replayed from a history — each is refused, and the refusal quotes the body to send. A key this
 *   route does not know is refused rather than ignored: somebody sending `dryRun` expects it to mean
 *   "do not do it", and ignoring it would do it.
 * * **No open confirmation window.** Powering off inside one is not a way to keep the change: the
 *   start-up sweep reverts every unconfirmed transaction at the next boot, which on this board is
 *   whenever somebody cycles the power — hours later, with nobody watching.
 * * **Recorded before it is done**, in the event ring, which is the only record that survives the
 *   outage it causes. With the boot identity and the uptime as well as the wall-clock `at`: the board
 *   has no clock battery, so `at` is only as good as the clock was at that moment, and the row says
 *   whether it was synchronised.
 * * **Answered before it is done.** The power-off is asked for after the reply has finished, plus a
 *   short delay, so the browser gets a 202 rather than a dropped connection it would read as a failure.
 *   It goes through `context.platform`, which is what a test replaces.
 */
function registerPowerOff(app: FastifyInstance, context: ServerContext): void {
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();
  // Held for the life of this process, which is exactly the span in which a second request matters.
  let underWay = false;

  typed.post(
    '/api/system/poweroff',
    {
      preHandler: requireScope('admin'),
      // The body is checked by hand below, so the refusal can say what to send; a validation failure
      // would answer in the validator's words. The schema is here for the documentation.
      attachValidation: true,
      schema: {
        summary: 'Switch the device off. It stays off until its power is cycled.',
        description:
          `Send exactly \`${POWER_OFF_BODY}\`; anything else, including no body, is refused and nothing is done. ` +
          'Refused while a transaction is awaiting confirmation, because the start-up sweep would revert it at ' +
          'the next boot. The request is written to the event ring first, then answered with 202, and the ' +
          'power-off is asked for a few seconds after the answer has been sent. The Wi-Fi, the access point ' +
          'and every tunnel go with it, and nothing turns the device back on by itself.',
        body: PowerOffRequest,
        response: { 202: PowerOffResponse, 400: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      /*
       * First, and before anything is read or written. Checked against the raw body rather than a
       * schema-shaped one: exactly one key, and it is the word.
       */
      const body: unknown = request.body;
      const confirmed =
        typeof body === 'object' &&
        body !== null &&
        !Array.isArray(body) &&
        Object.keys(body).length === 1 &&
        (body as Record<string, unknown>)['confirm'] === POWER_OFF_CONFIRMATION;
      if (!confirmed) {
        return reply.status(400).send({
          error: {
            code: 'confirmation_required',
            message: 'Switching the device off needs an explicit confirmation in the request body. Nothing was done.',
            hint: `send ${POWER_OFF_BODY} as the JSON body, and nothing else`,
          },
        });
      }

      const delayMs = context.powerOffDelayMs ?? POWER_OFF_DELAY_MS;
      const answer = {
        accepted: true,
        poweringOffInSeconds: Math.ceil(delayMs / 1000),
        message: 'The device is switching off. It stays off until its power is cycled.',
      };

      // A double tap, or a retry of a reply the phone never saw: the same answer, and no second record.
      if (underWay) return reply.status(202).send(answer);

      const open = context.profileRoutes?.profiles.unconfirmedTransaction() ?? null;
      if (open !== null) {
        const uptime = await context.platform.host.uptimeSeconds().catch(() => null);
        const remaining = windowCountdown(open, uptime, new Date()).secondsRemaining;
        return reply.status(409).send({
          error: {
            code: 'confirmation_pending',
            message:
              `Transaction ${open.id} is inside its confirmation window with ` +
              `${remaining === null ? 'an unknown time' : `${remaining} seconds`} left. Switching off now means it ` +
              'is reverted by the start-up sweep at the next boot, whenever the power is cycled, without anyone ' +
              'being asked. Nothing was done.',
            hint: `POST /api/transactions/${open.id}/confirm to keep it, or /revert to undo it, then switch off.`,
            detail: { transaction: open.id, secondsRemaining: remaining },
          },
        });
      }

      const who = requestedBy(request, context);
      const stamp = await currentStamp(context);
      const clock = await context.platform.clock.status().catch(() => null);
      context.store.recordEvent({
        level: 'warn',
        kind: 'system.poweroff',
        summary: `switched off on request by ${who.label}; it stays off until its power is cycled`,
        detail: {
          requestedBy: who.record,
          bootId: stamp?.bootId ?? null,
          uptimeSeconds: stamp?.uptimeSeconds ?? null,
          clockSynchronized: clock?.synchronized ?? null,
        },
      });
      underWay = true;

      try {
        // A Fastify reply settles when the response has finished, so the wait below starts after the
        // bytes are gone, not after they were queued.
        await reply.status(202).send(answer);
      } catch {
        // The caller went away before the answer finished. The act was confirmed and is on record, so it
        // proceeds: a record saying the device was switched off, beside a device still running, would be
        // the one outcome worse than either.
      } finally {
        setTimeout(() => {
          void context.platform.systemd
            .poweroff(`requested by ${who.label}`)
            .catch((error: unknown) => ({ ok: false, message: String(error) }))
            .then((result) => {
              if (result.ok) return;
              underWay = false;
              context.store.recordEvent({
                level: 'error',
                kind: 'system.poweroff-failed',
                summary: `the switch-off asked for by ${who.label} was not started: ${result.message}`,
                detail: { requestedBy: who.record, message: result.message },
              });
            });
        }, delayMs);
      }
      return reply;
    },
  );
}

/**
 * `POST /api/tunnels/:id/restart`: restart the units one running tunnel is made of, on request.
 *
 * ## The symptom it exists for
 *
 * Measured on the bench board, 2026-10-09 09:38–09:44: `office` (OpenVPN, four `remote` lines,
 * `remote-random`) could not reach `10.127.0.32:443` — from the core and bound to `wfvpnoff` alike —
 * while its peer's keepalive arrived, its pushed gateway answered pings and its pushed resolver answered
 * over TCP. Nothing on the device restarted it, and nothing was wrong by any measure it takes: OpenVPN's
 * `ping-restart` fires on silence from the peer, systemd's `Restart=always` on the process exiting, and
 * the watchdog reads the tunnel's own liveness and never restarts anything. A restart by hand landed on
 * another server (`213.226.70.3`, a different pushed subnet and resolver), and the same host answered
 * `200` six times running. A path broken **behind** a live peer is invisible to every automatic
 * mechanism here, so the owner asked for a button.
 *
 * ## The guards, and why each
 *
 * * **`apply`**, not `admin`: a restart changes nothing that persists, and the tunnel comes back by itself
 *   or not at all — the same as a reconnection its peer can cause at any moment.
 * * **Only a tunnel the last applied plan runs**, read from `store.device().tunnelUnits`. Unit names are
 *   never built from the request: the id is looked up, and only the names the plan recorded are touched.
 * * **A tunnel with no units of its own is refused**, not served by restarting the core: a tunnel carried
 *   inside the core has no process of its own, and restarting the core bounces every tunnel at once.
 * * **Not while an apply is running.** The reconciler restarts these same units, and two restarts racing
 *   leave a state neither of them chose.
 * * **One restart of a tunnel at a time**, for the double tap.
 *
 * Answered after the jobs finish, with each unit read back: a job systemd calls `done` on a unit that
 * exited at once is not a restart. Whether the tunnel then connected is the watchdog's next reading.
 */
function registerTunnelRestart(app: FastifyInstance, context: ServerContext): void {
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();
  const underWay = new Set<string>();

  typed.post(
    '/api/tunnels/:id/restart',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Restart one running tunnel: its client process reconnects. Nothing in the configuration changes.',
        description:
          'Restarts, in order, the units the last applied plan recorded for this tunnel, waits for each job, and ' +
          'reads each unit back. Refused for a tunnel the running plan does not have (404), for one with no units ' +
          'of its own (409), while an apply is running (409), and while a restart of the same tunnel is under way ' +
          '(409). Whether the tunnel connected afterwards is the watchdog\'s next reading in `GET /api/observers`.',
        params: Type.Object({ id: Type.String() }),
        response: { 200: TunnelRestartResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const entry = (context.store.device().tunnelUnits ?? []).find((tunnel) => tunnel.id === id);
      if (entry === undefined) {
        return reply.status(404).send({
          error: {
            code: 'tunnel_not_running',
            message: `No tunnel "${id}" is in the configuration this device is running. Nothing was done.`,
            hint: 'a tunnel exists here once the profile that names it has been applied',
          },
        });
      }
      if (entry.units.length === 0) {
        return reply.status(409).send({
          error: {
            code: 'tunnel_has_no_units',
            message:
              `Tunnel "${id}" runs no process of its own: it is carried inside the proxy core, and restarting the ` +
              'core would interrupt every tunnel at once. Nothing was done.',
          },
        });
      }
      const applying = context.profileRoutes?.profiles.recentTransactions(5).find((row) => row.state === 'applying');
      if (applying !== undefined) {
        return reply.status(409).send({
          error: {
            code: 'apply_in_progress',
            message: `Transaction ${applying.id} is being applied and restarts these units itself. Nothing was done.`,
            hint: 'try again once the apply has finished',
            detail: { transaction: applying.id },
          },
        });
      }
      if (underWay.has(id)) {
        return reply.status(409).send({
          error: { code: 'restart_under_way', message: `Tunnel "${id}" is already being restarted. Nothing more was done.` },
        });
      }

      underWay.add(id);
      const who = requestedBy(request, context);
      try {
        const units: { unit: string; result: string; active: boolean | null }[] = [];
        for (const unit of entry.units) {
          const job = await context.platform.systemd
            .restart(unit)
            .catch((error: unknown) => ({ result: `error: ${String(error)}` }));
          const state = await context.platform.systemd.state(unit).catch(() => null);
          units.push({ unit, result: job.result, active: state === null ? null : state.isActive });
        }
        const restarted = units.every((unit) => unit.result === 'done' && unit.active === true);
        const described = units
          .map((unit) => `${unit.unit}: ${unit.result}, ${unit.active === null ? 'state unread' : unit.active ? 'active' : 'not active'}`)
          .join('; ');
        context.store.recordEvent({
          level: restarted ? 'info' : 'warn',
          kind: restarted ? 'tunnel.restarted' : 'tunnel.restart-failed',
          summary: restarted
            ? `tunnel "${id}" restarted on request by ${who.label}: ${described}`
            : `tunnel "${id}" was asked to restart by ${who.label} and did not come back running: ${described}`,
          detail: { tunnel: id, requestedBy: who.record, units },
        });
        return reply.status(200).send({
          tunnel: id,
          restarted,
          units,
          message: restarted
            ? `Tunnel "${id}" was restarted. Whether it has connected shows in its health within about a minute.`
            : `Tunnel "${id}" did not come back running: ${described}.`,
        });
      } finally {
        underWay.delete(id);
      }
    },
  );
}

/**
 * Who asked, in words for the event summary and as a record for its detail.
 *
 * **Never the session id**: it is the credential itself, the event ring is readable with the `read`
 * scope, and a peer's read token would then carry the operator's session. A browser session is named by
 * where it came from instead, which is what a login event already records. A token is named by its id
 * and the name it was given, neither of which is its secret.
 */
function requestedBy(
  request: FastifyRequest,
  context: ServerContext,
): { label: string; record: Record<string, string | null> } {
  const auth = request.auth;
  if (auth?.kind === 'token') {
    const name = context.store.tokens().find((token) => token.id === auth.id)?.name ?? null;
    return {
      label: name === null ? `token ${auth.id}` : `token "${name}"`,
      record: { kind: 'token', id: auth.id, name },
    };
  }
  return {
    label: `a signed-in session from ${request.ip}`,
    record: { kind: 'session', source: request.ip, userAgent: request.headers['user-agent'] ?? null },
  };
}

function registerRoutes(app: FastifyInstance, context: ServerContext, accessIndex: RouteAccessIndex): void {
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();

  typed.get(
    '/api/health',
    {
      schema: {
        summary: 'Liveness, reachable with no credential at all.',
        description:
          '`setupComplete` is false while the shipped default password is still in place. It is a ' +
          'fact reported, not a permission: nothing is refused because of it.',
        response: { 200: HealthResponse },
      },
    },
    async () => ({
      ok: true,
      uptimeSeconds: daemonUptimeSeconds(),
      setupComplete: context.store.device().setupComplete,
    }),
  );

  typed.get(
    '/api/system',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'Versions, uptime, clock and whether a proxy core was detected.',
        response: { 200: SystemResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => {
      const device = context.store.device();
      const clock = await context.platform.clock.status();
      const inventory = await inventorySnapshot(context);
      /*
       * One reading, for three fields off one result.
       *
       * It was called three times, once per field, on a polled endpoint — and the accessor is not a
       * stored value: each call rebuilds an interfaces-by-addresses computation. Three readings of
       * one fact is also three chances for them to disagree, which on a view whose whole purpose is
       * to say what this device decided about its own reachability would be the worst kind of
       * inconsistency: two fields describing different moments with nothing saying so.
       */
      const channels = context.managementChannels?.() ?? null;
      return {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        activeProfile:
          device.activeProfileId === null
            ? null
            : (context.profileRoutes?.profiles.get(device.activeProfileId)?.name ?? null),
        version: context.version,
        buildAt: context.buildAt,
        runtime: process.version,
        startedAt: context.startedAt.toISOString(),
        uptimeSeconds: daemonUptimeSeconds(),
        setupComplete: device.setupComplete,
        apiEnabled: device.apiEnabled,
        schemaVersion: SCHEMA_VERSION,
        /*
         * The channels, the refusals and the withholdings, on the wire.
         *
         * **A key `SystemResponse` does not declare is dropped here silently** — no error, no log
         * line — because a Fastify response schema is a serializer. These three were returned by
         * this handler and arrived nowhere for exactly that reason, which is the trap recorded in
         * `docs/16`. `SystemResponse` carries them as of 2026-09-21, and what keeps them from being
         * dropped again is not this comment: `test/management-visibility.test.ts` reads them off
         * `app.inject`, so removing them from the schema turns three tests red naming the cause.
         *
         * Null when the policy has not run yet, and null reaches the client as null: "not decided"
         * is not "nothing was refused", and an empty list is the reassuring answer given in exactly
         * the case where nobody has looked.
         */
        channels: channels?.channels ?? null,
        refused: channels?.refused ?? null,
        withheld: channels?.withheld ?? null,
        listen: {
          port: context.config.listen.port,
          addresses: context.boundAddresses,
          unresolvedInterfaces: context.unresolvedInterfaces,
        },
        clock: {
          timezone: clock.timezone,
          ntpEnabled: clock.ntpEnabled,
          synchronized: clock.synchronized,
        },
        binaries: inventory.binaries,
        warnings: [...context.configWarnings, ...inventory.notes],
      };
    },
  );

  registerPowerOff(typed, context);
  registerTunnelRestart(typed, context);

  typed.get(
    '/api/capabilities',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'What this device can do, what is missing, and the command that fixes each gap.',
        description:
          'A capability is `available`, `missing`, or `unknown` — a question the device could not answer, which is not a gap. A remedy carries the command because the package name is usually not the binary name; some gaps carry no command at all, because no install fixes them.',
      },
    },
    async () => {
      const inventory = await inventorySnapshot(context);
      const capabilities = describeCapabilities(inventory);
      return {
        capabilities,
        /*
         * Counted here rather than left to a client. Two clients counting "how many gaps" would eventually
         * disagree about whether `unknown` is a gap — and it is not: it is a question the device could not
         * answer, which is a different thing from a thing the device cannot do.
         */
        summary: {
          available: capabilities.filter((entry) => entry.state === 'available').length,
          missing: capabilities.filter((entry) => entry.state === 'missing').length,
          unknown: capabilities.filter((entry) => entry.state === 'unknown').length,
        },
      };
    },
  );

  /* ── the aggregate view ─────────────────────────────────────────────────────────────────── */

  typed.get(
    '/api/fleet',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: "This device and its peers, each peer's own summary. Read-only: no route changes a peer.",
        description:
          'Peer state is three-valued: `answered`, `refused` (working, and declining the credential) and `unreachable` (nothing came back). The last two call for different actions, and one error code would hide which.',
      },
    },
    async () => {
      const device = context.store.device();
      const peers = context.store.peers().map((peer) => ({
        id: peer.id,
        label: peer.label,
        baseUrl: peer.baseUrl,
        token: context.store.peerToken(peer.id),
      }));

      const rows = await collectFleet(
        {
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          version: context.version,
          uptimeSeconds: daemonUptimeSeconds(),
          activeProfile:
            device.activeProfileId === null
              ? null
              : (context.profileRoutes?.profiles.get(device.activeProfileId)?.name ?? null),
        },
        peers,
        { fetchJson: fetchPeerJson },
      );

      return { devices: rows, duplicateIdentities: duplicateIdentities(rows) };
    },
  );

  typed.get(
    '/api/peers',
    {
      preHandler: requireScope('read'),
      schema: { summary: 'The peers whose summaries appear in the aggregate view.' },
    },
    async () => ({
      peers: context.store.peers(),
    }),
  );

  typed.post(
    '/api/peers',
    {
      preHandler: requireScope('admin'),
      schema: { summary: 'Add a peer, with a read-scoped token that peer issued.' },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { label?: unknown; baseUrl?: unknown; token?: unknown };
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      const token = typeof body.token === 'string' ? body.token : '';

      if (label === '' || baseUrl === '' || token === '') {
        return reply.status(400).send({
          error: {
            code: 'invalid_request',
            message: 'a peer needs a label, a base URL and a read-scoped token issued by that peer',
            hint: 'On the other device: create an API token with the read scope, then add it here.',
          },
        });
      }
      // Refused rather than normalised. A base URL we silently rewrote would be a different address from
      // the one the operator typed, and the first symptom would be a peer that is permanently unreachable for
      // reasons the screen cannot explain.
      if (!/^https?:\/\//.test(baseUrl)) {
        return reply.status(400).send({
          error: {
            code: 'invalid_request',
            message: `"${baseUrl}" is not an http or https address`,
            hint: "Give the peer's full base URL, for example http://192.0.2.10:8088",
          },
        });
      }

      const peer = context.store.addPeer({ label, baseUrl, token });
      context.store.recordEvent({
        level: 'info',
        kind: 'fleet.peer-added',
        summary: `peer "${label}" added at ${baseUrl}`,
        detail: { peer: peer.id, baseUrl },
      });
      return reply.status(201).send(peer);
    },
  );

  typed.delete(
    '/api/peers/:id',
    {
      preHandler: requireScope('admin'),
      schema: { summary: 'Remove a peer from the aggregate view. Nothing on the peer itself changes.' },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!context.store.removePeer(id)) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'no such peer' } });
      }
      context.store.recordEvent({
        level: 'info',
        kind: 'fleet.peer-removed',
        summary: 'a peer was removed from the aggregate view',
        detail: { peer: id },
      });
      return reply.status(204).send();
    },
  );

  typed.get(
    '/api/inventory',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'Discovered hardware, the capabilities its drivers report, and the bindings it could be given.',
        description:
          'The `candidates` lists answer "which piece of hardware do I point this role at" without asking for a plan. Absent means nobody looked; an empty list means this device was asked and has no hardware of that kind.',
        response: { 200: InventoryResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => {
      const inventory = await inventorySnapshot(context, true);
      /*
       * Answered here, on the question about hardware, rather than only inside a plan.
       *
       * The list was reachable only through the plan of the **active** profile — which is a plan
       * review, and is not available at all while editing the binding of any other profile. That is
       * the moment the chooser is needed. Built by the resolver's own function and not re-derived:
       * one rule about what a piece of hardware is, on the device.
       */
      return {
        ...inventory,
        candidates: {
          radios: bindingCandidates(inventory, true),
          interfaces: bindingCandidates(inventory, false),
        },
      };
    },
  );

  typed.get(
    '/api/status',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'The assembled live state: interfaces, units, access points, clock and poller counters.',
        response: { 200: StatusResponse, 403: ErrorResponse },
      },
    },
    async () => {
      const snapshot = context.telemetry.snapshot();
      return { ...snapshot, stationHistory: context.telemetry.stationHistory() };
    },
  );

  /**
   * Does this device match its stored profile?
   *
   * The one question `docs/13-plan.md` row G1 exists for, answered from a re-derivation of the
   * **stored** profile against the files on disk and the units systemd reports — never against the
   * last applied document, which per row G4 can name something the device never fully ran.
   *
   * A separate route rather than a field on `/api/status`: that endpoint is the telemetry snapshot, a
   * poll of the running system, and this is a comparison with what was asked for. Folding one into
   * the other would make a status poll re-plan the profile.
   */
  typed.get(
    '/api/drift',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'Whether what is on this device matches what the stored profile says it should be.',
        description:
          'A divergence names the file path or the JSON Pointer inside it and both values. ' +
          '`report: null` means the check has not run once — it is not a statement that nothing diverged.',
        response: { 200: DriftResponse, 403: ErrorResponse },
      },
    },
    async () => {
      const current = (await context.drift?.()) ?? { report: null, ageSeconds: null };
      /*
       * `checkedAtMonotonicMs` is this process's `performance.now()` and means nothing to a client, so it
       * is left off the wire — here, by name. It used to be left off by the response schema not declaring
       * it, which removes a field without saying so; that is the mechanism that hid three fields of the
       * watchdog's reading on 2026-09-24 (`serialiser-loss.ts`).
       */
      const report =
        current.report === null
          ? null
          : (({ checkedAtMonotonicMs: _processLocal, ...rest }) => rest)(current.report);
      return {
        report,
        ageSeconds: current.ageSeconds,
        summary:
          current.report === null
            ? 'this device has not yet been compared with its stored profile'
            : summarise(current.report),
      };
    },
  );

  /**
   * Is every mechanism that watches the world actually watching it?
   *
   * Added 2026-09-23. The resolver follower did nothing for ten hours on the bench board and nothing
   * said so, because it spoke only when it acted. Every observer now says when it last looked, when it
   * last acted, and — as a problem — when it is not running or has not looked within its cadence.
   */
  typed.get(
    '/api/observers',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'Every mechanism that watches or waits for something, when it last looked and acted, and whether it is running.',
        description:
          'An observer that is not running, or that has not looked within one and a half times its own ' +
          'cadence, is reported with a `problem`. Ages are from the daemon’s monotonic clock; `at` is for ' +
          'reading only, because this board has no clock battery.',
        response: { 200: ObserversResponse, 403: ErrorResponse },
      },
    },
    async () => {
      const observers = context.observers();
      return { observers, problems: observers.filter((entry) => entry.state !== 'ok').length };
    },
  );

  /**
   * How old is each list this device is routing on?
   *
   * The obligation that comes with falling back to the copy on disk when a refresh fails. A stale
   * list does not know addresses allocated since it was written, so a rule meant to send a whole
   * country somewhere quietly stops covering part of it while the tunnel, the rule and the core all
   * look healthy.
   *
   * Separate from `/api/drift` because it answers a different question: drift lists what is wrong,
   * and this reports a reading for **every** set in use, so a screen can tell "this list is fine"
   * apart from "this list was not looked at". The overdue ones appear in both.
   */
  typed.get(
    '/api/rule-sets',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'When each rule set the routing uses was last refreshed on this device.',
        description:
          '`ageSeconds` is null whenever no honest number exists — an unsynchronised clock, a set ' +
          'never fetched, a file that could not be read, a timestamp the clock cannot support. It is ' +
          'never a zero and never a guess. For a remote set the figure is a **lower bound** shared by ' +
          'every remote set (`exact: false`): the core keeps them all in one cache file this device ' +
          'does not read inside, so a fresh-looking figure means something in the cache was ' +
          'refreshed, not that this set was. `profileId` names the profile the answer is about — it ' +
          'is always the **active** one, because the ages describe files this device actually holds.',
        response: { 200: RuleSetAgesResponse, 403: ErrorResponse },
      },
    },
    async () => context.ruleSetAges(),
  );

  /**
   * One event stream. A snapshot is sent on connect, so a client never needs a separate
   * "get current state" call to initialise, and `Last-Event-ID` lets a reconnecting client
   * see whether it missed anything.
   */
  typed.get(
    '/api/events',
    {
      preHandler: requireScope('read'),
      schema: { summary: 'The event stream (SSE). A snapshot is sent on connect, and bursts are coalesced.' },
    },
    async (request, reply) => {
      /*
       * **A request for a list is refused rather than streamed at.**
       *
       * Measured 2026-09-22: `GET /api/events?limit=25` from a laptop did not return in 120 s. Nothing
       * was stuck. This route is the live stream — it answers `200`, writes a snapshot and then stays
       * open for as long as the client does, by design — and it ignored `limit`, because it takes no
       * parameters. The stored events a person asking for "the last 25" wants are `GET /api/eventlog`.
       * A route whose name is one word from the list and which never finishes is a trap, so a request
       * that is plainly asking for a list — it carries a query, or it does not accept an event stream
       * (every `EventSource` sends `Accept: text/event-stream`; `curl` sends `*\/*`) — is told where the
       * list is, at once.
       */
      const query = Object.keys((request.query as Record<string, unknown> | null) ?? {});
      const accept = request.headers.accept ?? '';
      if (query.length > 0 || !accept.includes('text/event-stream')) {
        return reply.status(query.length > 0 ? 400 : 406).send({
          error: {
            code: 'stream_not_list',
            message:
              'GET /api/events is the live event stream (server-sent events): it takes no parameters and ' +
              'does not end while the client stays connected. ' +
              (query.length > 0
                ? `It was asked for ${query.join(', ')}, which it does not take. `
                : 'This request does not accept text/event-stream. ') +
              'The stored events, with limit, kind, level and since, are GET /api/eventlog.',
            hint:
              'GET /api/eventlog?limit=25 for the last 25 stored events; or send Accept: text/event-stream ' +
              'and no query to follow the live stream.',
            detail: { list: '/api/eventlog', ignored: query },
          },
        });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Without this a reverse proxy may buffer the stream into uselessness.
        'X-Accel-Buffering': 'no',
      });

      const send = (event: string, data: unknown, id?: number): void => {
        if (reply.raw.writableEnded) return;
        if (id !== undefined) reply.raw.write(`id: ${id}\n`);
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const lastEventId = Number(request.headers['last-event-id'] ?? '0');
      send('hello', {
        at: new Date().toISOString(),
        // A client that reconnects after a daemon restart must resynchronise rather than assume
        // its cached ids are still meaningful; the id space is per process.
        processStartedAt: context.startedAt.toISOString(),
        lastEventIdSeen: Number.isFinite(lastEventId) ? lastEventId : 0,
      });
      send('status', { ...context.telemetry.snapshot(), stationHistory: context.telemetry.stationHistory() });

      const unsubscribe = context.telemetry.subscribe((event) => send(event.event, event.data, event.id));
      // A comment line every 25 seconds: it keeps intermediaries from closing an idle stream and
      // costs nothing.
      const keepAlive = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n');
      }, 25_000);
      keepAlive.unref();

      request.raw.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });

      return reply;
    },
  );

  typed.get(
    '/api/logs',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'Journal lines from RAM. Pages forward with an opaque cursor, with no gap.',
        description:
          'A request with no cursor returns the newest entries; one with a cursor returns the entries immediately after it, in order, with no gap. `hasMore` means more entries exist beyond this page, not merely that the page came out full.',
        querystring: LogsQuery,
        response: { 200: LogsResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const query = request.query;
      const result = await context.platform.journal.read({
        ...(query.unit !== undefined ? { unit: query.unit } : {}),
        ...(query.level !== undefined ? { maxPriority: query.level } : {}),
        ...(query.since !== undefined ? { since: query.since } : {}),
        ...(query.grep !== undefined ? { grep: query.grep } : {}),
        ...(query.cursor !== undefined ? { afterCursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });

      const currentBootEntries = result.entries.filter(
        (entry) => result.currentBootId === null || entry.bootId === result.currentBootId,
      );

      return {
        source: 'journal' as const,
        entries: result.entries.map((entry) => ({
          at: entry.atMs === null ? null : new Date(entry.atMs).toISOString(),
          atMs: entry.atMs,
          priority: entry.priority,
          unit: entry.unit,
          identifier: entry.identifier,
          message: entry.message,
          bootId: entry.bootId,
          cursor: entry.cursor,
        })),
        nextCursor: result.nextCursor,
        currentBootId: result.currentBootId,
        containsEarlierBoots: result.containsEarlierBoots,
        hasMore: result.hasMore,
        incomplete: result.incomplete,
        incompleteReason: result.incompleteReason,
        currentBootEmpty: currentBootEntries.length === 0,
      };
    },
  );

  typed.get(
    '/api/eventlog',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'The persistent event ring from the database: significant events only, and it survives power loss.',
        querystring: EventLogQuery,
        response: { 200: EventLogResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const query = request.query;
      // One call, so the page and the "how many are kept" figure describe the same instant.
      const page = context.store.eventPage({
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        ...(query.level !== undefined ? { level: query.level } : {}),
        ...(query.since !== undefined ? { since: query.since } : {}),
      });
      return { source: 'database' as const, capacity: 5000, count: page.total, entries: page.entries };
    },
  );

  typed.post(
    '/api/debug/log-level',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'Raise the log level for a bounded period. It lowers itself again.',
        body: DebugLevelRequest,
        response: { 200: DebugLevelResponse, 403: ErrorResponse },
      },
    },
    async (request) => context.setLogLevel(request.body.level, request.body.minutes),
  );

  typed.post(
    '/api/auth/login',
    {
      schema: {
        summary: 'Sign in with the admin password and receive a session cookie.',
        body: LoginRequest,
        response: { 200: LoginResponse, 401: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (request, reply) => {
      const source = request.ip;
      const stamp = await currentStamp(context);
      const failures = context.store.recentLoginFailures(source, LOGIN_WINDOW_SECONDS, stamp);
      if (failures >= LOGIN_MAX_FAILURES) {
        context.store.recordEvent({
          level: 'warn',
          kind: 'auth.locked',
          summary: `login locked out for ${source} after ${failures} failures`,
          detail: { source, failures, windowSeconds: LOGIN_WINDOW_SECONDS, bootId: stamp?.bootId ?? null },
        });
        return reply.status(429).send({
          error: {
            code: 'too_many_attempts',
            message: `too many failed attempts from ${source}`,
            hint: 'wait for the lockout window to pass',
          },
        });
      }

      const device = context.store.device();
      // A device whose password has never been set accepts the documented default, so the
      // credentials the installer printed work. Nothing then forces a change: see E16 and
      // `docs/10-security.md`.
      const ok =
        device.adminPasswordHash === ''
          ? request.body.password === DEFAULT_PASSWORD
          : await context.store.verifyAdminPassword(request.body.password);

      context.store.recordLoginAttempt(source, ok, undefined, stamp);
      if (!ok) {
        context.store.recordEvent({
          level: 'warn',
          kind: 'auth.failed',
          summary: `failed login from ${source}`,
          detail: { source },
        });
        return reply.status(401).send({ error: { code: 'invalid_credentials', message: 'wrong password' } });
      }

      const session = context.store.createSession(request.headers['user-agent'] ?? null, undefined, stamp);
      context.store.recordEvent({
        level: 'info',
        kind: 'auth.login',
        summary: `login from ${source}`,
        detail: { source },
      });

      void reply.setCookie(SESSION_COOKIE, session.id, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        // Secure is set only when TLS is in use: on a LAN with no name and no certificate
        // authority, marking the cookie secure over plain HTTP simply breaks the session.
        secure: false,
      });

      /*
       * `setupComplete` is a **fact about this device**, not a permission: false means the shipped
       * default password is still in place. It gates nothing, here or anywhere else, and it is
       * reported so an operator and a fleet view can see a device still on its default.
       *
       * `mustChangePassword` was here and is gone with the field itself. Worth a line because
       * nothing would have complained if it had stayed: `LoginResponse` no longer declares it, and
       * Fastify's serialiser drops an undeclared field **without a word** — the same silence that
       * hides a field somebody meant to add hides one somebody meant to remove. A producer still
       * computing a value no serialiser emits is not harmless; it is a working-looking expression
       * that the next reader either restores to the schema or spends an afternoon chasing.
       */
      return { setupComplete: device.setupComplete };
    },
  );

  typed.post(
    '/api/auth/logout',
    {
      schema: {
        summary: 'End this session. The session row is deleted, so revocation is immediate.',
        description:
          'Reachable by any authenticated credential and checks no scope, which is not an oversight: the ' +
          'credential ending a session is the operator holding it, and a scope check that can never fail ' +
          'is worse than none because it reads as protection.',
      },
    },
    async (request, reply) => {
      const sessionId = request.cookies[SESSION_COOKIE];
      if (typeof sessionId === 'string' && sessionId !== '') context.store.deleteSession(sessionId);
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  typed.post(
    '/api/auth/password',
    {
      schema: {
        summary: 'Change the admin password. Every open session ends, including this one.',
        description:
          "Ending every session is what bounds a session's life: there is no absolute expiry, so a credential change is what retires everything issued under the old one.",
        body: ChangePasswordRequest,
        response: { 200: LoginResponse, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (request, reply) => {
      const device = context.store.device();
      const currentOk =
        device.adminPasswordHash === ''
          ? request.body.currentPassword === DEFAULT_PASSWORD
          : await context.store.verifyAdminPassword(request.body.currentPassword);

      if (!currentOk) {
        return reply.status(401).send({
          error: { code: 'invalid_credentials', message: 'the current password is wrong', pointer: '/currentPassword' },
        });
      }
      if (request.body.newPassword === DEFAULT_PASSWORD) {
        return reply.status(400).send({
          error: {
            code: 'invalid_request',
            message: 'the new password must not be the documented default',
            pointer: '/newPassword',
          },
        });
      }

      await context.store.setAdminPassword(request.body.newPassword);
      /*
       * Every session ends, including this one.
       *
       * This is what bounds a session's life now that there is no absolute expiry: a credential change
       * invalidates everything issued under the old one. It needs no clock, which is the point — the
       * wall-clock expiry it replaces was unenforceable on a board whose clock can be days out, and was
       * the last reader of a model the authorisation path had already abandoned.
       *
       * Signing the operator out of the tab they just changed their password in is the correct cost. The
       * alternative is a session that was created under a password the operator has deliberately retired,
       * which is the one case where "it was valid when it was issued" is not a good enough answer.
       */
      const endedSessions = context.store.revokeAllSessions();
      context.store.recordEvent({
        level: 'info',
        kind: 'auth.password-changed',
        summary:
          endedSessions === 1
            ? 'admin password changed; the one open session was ended'
            : `admin password changed; ${endedSessions} open session(s) were ended`,
        detail: { endedSessions },
      });
      return { setupComplete: true };
    },
  );

  typed.get(
    '/api/tokens',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'The API tokens that exist, without their secrets.',
        response: { 200: Type.Array(TokenSummary) },
      },
    },
    async () => context.store.tokens(),
  );

  typed.post(
    '/api/tokens',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'Create an API token. The value is returned once and never again.',
        body: CreateTokenRequest,
        response: { 200: CreateTokenResponse },
      },
    },
    async (request) => {
      const created = context.store.createToken(request.body.name, request.body.scopes, request.body.expiresAt ?? null);
      context.store.recordEvent({
        level: 'info',
        kind: 'token.created',
        summary: `API token "${request.body.name}" created`,
        detail: { scopes: request.body.scopes },
      });
      return { token: created.token, summary: created.row };
    },
  );

  typed.delete(
    '/api/tokens/:id',
    {
      preHandler: requireScope('admin'),
      schema: {
        summary: 'Delete an API token, which takes effect immediately.',
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (request, reply) => {
      const removed = context.store.deleteToken(request.params.id);
      if (!removed) return reply.status(404).send({ error: { code: 'not_found', message: 'no such token' } });
      context.store.recordEvent({ level: 'info', kind: 'token.deleted', summary: 'API token deleted' });
      return { ok: true };
    },
  );

  /*
   * Two renderings, one document.
   *
   * `enrichedOpenapi` is the only producer: the tool-readable form and the human-readable page are
   * the same facts with different presentation, so there is no way for one of them to be right. A
   * hand-written page that disagreed with the routes would be worse than no page, because the reader
   * cannot tell which of the two lied.
   */
  typed.get(
    '/api/openapi.json',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'The OpenAPI document, generated from the route schemas and the live route table.',
        description:
          'Each operation carries `x-wayfarer-access`, which states the scope its guard requires. ' +
          'That fact is not in any schema — it lives in the route handler — so it is read back out of ' +
          'the registered routes rather than annotated by hand. /api/docs renders this same document.',
      },
    },
    async () => enrichedOpenapi(app, accessIndex),
  );

  /*
   * **Readable with no credential**, and that is a decision rather than an oversight.
   *
   * The endpoint's own justification is that "the operator who needs it is often on a network with
   * no route out" — and the person in that position most often has not logged in yet, because they
   * are reading a refusal. Every 401 and 404 now hands them this link, and a link that answers 401
   * is a wall with a signpost on it.
   *
   * What it exposes is **shapes, not data**: paths, parameter names, schemas and the scope each
   * route requires. No profile, no secret, no reading from the device, and nothing here that is not
   * already in this repository, which is published. Hiding a route table that anybody can read in
   * the source is obscurity, and obscurity that costs the operator the one page they need on a
   * device they cannot get into is a bad trade.
   *
   * `/api/openapi.json` is deliberately **not** changed with it, although it carries the same facts.
   * Nothing links to it from a refusal, and its reader is a client that is already integrating and
   * therefore already holds a credential. If that asymmetry ever needs resolving, the resolution is
   * to open the machine document too, not to close this page.
   */
  typed.get(
    '/api/docs',
    {
      schema: {
        summary: 'This page: every endpoint, generated from the schemas and guards in force right now.',
        description:
          'Rendered on the device and referencing nothing external, because the operator who needs it ' +
          'is often on a network with no route out. Readable with no credential, because that ' +
          'operator usually has not logged in yet — it describes shapes, never data. The ' +
          'machine-readable form is /api/openapi.json, which does require the read scope.',
      },
    },
    async (_request, reply) => {
      const html = renderApiDocs(viewOf(enrichedOpenapi(app, accessIndex)));
      return await reply.type('text/html; charset=utf-8').send(html);
    },
  );
}

/**
 * The shipped default password.
 *
 * Short and published, by the owner's decision, recorded in `docs/10-security.md` under *The default
 * password is short, by decision*. There is no forced change: it is a default, not a mode.
 *
 * One consequence worth naming where the value is, not only in the document: this string is **nine
 * characters and `ChangePasswordRequest` requires twelve**, so it cannot be set as a new password.
 * That disagreement is deliberate and it is a one-way valve — leaving the default is easy, returning
 * to it is impossible.
 */
export const DEFAULT_PASSWORD = 'adminpass';

/**
 * Inventory is cached for a few seconds: collecting it runs `iw phy`, `iw dev`, `iw reg get`,
 * `ip -j` three times and probes ten binaries, which is a lot of process spawns for a status page
 * that a browser may request twice in the same second.
 *
 * The cache hangs off the server instance rather than the module. A module-level cache is shared by
 * every server built in one process, which is invisible in production and makes any test that
 * builds two servers answer with the other one's hardware.
 */
const inventoryCaches = new WeakMap<ServerContext, { at: number; value: Inventory }>();

async function inventorySnapshot(context: ServerContext, fresh = false): Promise<Inventory> {
  const maxAgeMs = 5000;
  const cached = inventoryCaches.get(context);
  // `performance.now()`, not the wall clock. This is an elapsed time inside one process, and a backward
  // clock step would keep serving a five-second cache for as long as the step lasted — a status page
  // frozen for days with nothing to indicate it.
  if (!fresh && cached && performance.now() - cached.at < maxAgeMs) return cached.value;
  const value = await collectInventory(context.platform);
  inventoryCaches.set(context, { at: performance.now(), value });
  // Cached in the database only so the interface has something to show on a cold start; it is
  // re-derivable and never authoritative.
  context.store.cacheInventory(value);
  return value;
}
