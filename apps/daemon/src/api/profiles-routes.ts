/**
 * The profile, plan and apply routes.
 *
 * **Every route carries a scope guard.** `buildServer` refuses to start if one does not — an
 * `onRoute` hook collects any route under `/api/` without a guard and throws with their names. That
 * invariant is not weakened here: the guards are attached at the point of registration, and a route
 * added without one fails at construction rather than at the first request from a token that should
 * not have reached it.
 *
 * Two rules about what leaves this file:
 *
 * * **A generated artefact is never returned.** The resolved core configuration contains real
 *   credentials by necessity. Plan review returns paths, purposes and the classified diff — never
 *   contents — and the diff is rendered from the profile document, where secrets are still wrapped.
 * * **A secret is never returned.** A read gives `{ "$set": true | false }`; a full export needs the
 *   `admin` scope and is recorded as an event.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  applyWrite,
  ErrorResponse,
  ProfileDocument,
  ProfileVersionError,
  emptyProfile,
  isStoredSecret,
  matchesPointer,
  secretMatchers,
} from '@wayfarer/schemas';
import type { ProfileStore } from '../state/profiles.ts';
import type { Store } from '../state/store.ts';
import type { Plan } from '../core/planner.ts';
import { type Plan2, type Reality } from '../core/differ.ts';
import type { ApplyClass } from '../core/reconciler.ts';
import type { Platform } from '../platform/index.ts';
import type { Inventory } from '../inventory/index.ts';
import type { RuntimeFacts } from '../core/invariants.ts';
import { buildRegistry } from '../core/providers.ts';
import { looksLikeSecretField, nodeName, parseForeignSchema, parseSubscription, type JsonSchemaNode } from '@wayfarer/protocols';
import { planDocument, type PipelineContext } from '../core/pipeline.ts';
import {
  applyDocument,
  confirmTransaction,
  maybeEnterSafeMode,
  revertTransaction,
  type ApplyDeps,
} from '../core/apply.ts';
import { REVERT_REASONS, SAFE_MODE_THRESHOLD } from '../core/safe-mode.ts';
import { windowCountdown } from '../core/transactions.ts';
import type { ProfileDocument as ProfileDocumentType } from '@wayfarer/schemas';

/** Attaches the marker `buildServer` looks for. Kept identical to the one in the server module. */
type ScopeGuard = ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) & {
  wayfarerScope: 'read' | 'apply' | 'admin';
};

export interface ProfileRoutesContext {
  store: Store;
  profiles: ProfileStore;
  platform: Platform;
  requireScope: (scope: 'read' | 'apply' | 'admin') => ScopeGuard;
  inventory: () => Promise<Inventory>;
  /** Facts about the running system the invariant checks read. Gathered here, used purely there. */
  facts: () => Promise<RuntimeFacts>;
  /**
   * Reality for exactly what this plan is about.
   *
   * `sysctlKeys` is part of the request rather than a list the caller keeps, and that is the fix for a
   * defect worth remembering: the keys were hardcoded while the generator emitted two more whenever
   * IPv6 was blocked, so those two were never read, the differ saw them as changed for ever, and
   * **every** plan was forced to `network`. The refusal then fired on every apply, including
   * immediately after a successful one.
   *
   * The damage was not the wrong class. It was that an operator or a script meeting a spurious refusal
   * every time learns to pass the narrowing automatically — and from then on a real network change
   * goes through the path built to stop it. A safety mechanism that cries wolf trains the bypass.
   */
  reality: (paths: string[], units: string[], sysctlKeys: string[]) => Promise<Reality>;
  managementPort: number;
  timePorts: number[];
  timeSyncUnit: string;
  upScriptPath: string;
  /**
   * The shared planning pipeline and the transaction layer around it.
   *
   * Both are built once by the composition root and handed in, because `way revert` and the start-up
   * sweep must use the same ones. A revert that planned through different code could disagree with the
   * apply it is undoing.
   */
  pipeline: PipelineContext;
  applyDeps: ApplyDeps;
}

const ApplyBody = Type.Object(
  {
    /**
     * Narrows the apply to these classes. Passing it is how a caller asks for the safe part of a
     * mixed plan, and it is never a default — a partial application must always be a deliberate act.
     */
    classes: Type.Optional(
      Type.Array(
        Type.Union([Type.Literal('hot'), Type.Literal('service'), Type.Literal('network'), Type.Literal('boot')]),
        { minItems: 1, maxItems: 4 },
      ),
    ),
  },
  { additionalProperties: false },
);

export function registerProfileRoutes(app: FastifyInstance, context: ProfileRoutesContext): void {
  const typed = app.withTypeProvider<TypeBoxTypeProvider>();
  const { profiles, store, requireScope } = context;

  /* ── CRUD ───────────────────────────────────────────────────────────────────────────────── */

  typed.get(
    '/api/profiles',
    { preHandler: requireScope('read'), schema: { summary: 'Every stored profile, as summaries.' } },
    async () => {
      const active = store.device().activeProfileId;
      return { profiles: profiles.list(active), activeProfileId: active };
    },
  );

  typed.post(
    '/api/profiles',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Create a profile from a document, validated and migrated on the way in.',
        // `Unknown`, and on purpose rather than by omission. The body is an envelope — `{name}` or
        // `{document}` — and the document inside it is **not** in the canonical shape yet: a write
        // may carry `{"$keep": true}` at a secret position, and an import may carry a document from
        // an older schema version. Neither validates against `ProfileDocument` until this handler
        // has resolved it. The union is enforced on the resolved document, at the store's write —
        // see `assertProfileDocument` in `state/profiles.ts`. Declaring the profile schema here
        // instead would refuse legitimate bodies and still not check what is stored.
        body: Type.Optional(Type.Unknown()),
      },
    },
    async (request, reply) => {
      // A new profile with nothing in it, rather than a blank document: no uplink, no access point, no
      // tunnel, kill-switch off. Every one of those absences is a decision recorded in the defaults.
      const body = (request.body ?? {}) as Record<string, unknown>;
      const document =
        typeof body['document'] === 'object' && body['document'] !== null
          ? body['document']
          : emptyProfile({ name: typeof body['name'] === 'string' ? body['name'] : 'New profile' });

      const created = profiles.create(document);
      store.recordEvent({ level: 'info', kind: 'profile.created', summary: `profile "${created.name}" created` });
      return reply.status(201).send({ id: created.id, name: created.name });
    },
  );

  typed.get(
    '/api/profiles/:id',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'One profile document in full, with its secrets redacted.',
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (request, reply) => {
      const document = profiles.getRedacted(request.params.id);
      if (document === null) return notFound(reply, 'profile');
      return {
        document,
        // The gaps a redacted import left, so the interface can show the checklist without a second call.
        missingSecrets: profiles.missing(request.params.id),
      };
    },
  );

  typed.put(
    '/api/profiles/:id',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Replace a profile document.',
        params: Type.Object({ id: Type.String() }),
        body: Type.Unknown(),
      },
    },
    async (request, reply) => {
      const existing = profiles.get(request.params.id);
      if (existing === null) return notFound(reply, 'profile');

      // A write accepts a literal value at a secret position, or `{"$keep": true}` to leave the stored
      // one alone. Without `$keep`, a form that saved what a GET gave it would blank every secret on
      // the first save of an unrelated field, and nothing would say so until a tunnel stopped working.
      // Matchers from the store, which gets them from the secret plan. Computing them here from the
      // static schema is exactly the defect this file used to carry: it covered nothing inside a
      // tunnel's opaque configuration, so a `$keep` for a tunnel credential resolved against nothing
      // and a literal one was stored in clear.
      const merged = applyWrite(request.body, existing.document, profiles.matchersFor(existing.document));
      if (merged.errors.length > 0) {
        const first = merged.errors[0]!;
        return reply.status(400).send({
          error: {
            code: 'invalid_secret_write',
            message: first.message,
            pointer: first.pointer,
            hint: 'Send the value itself, or {"$keep": true} to leave the stored one alone.',
            detail: { errors: merged.errors },
          },
        });
      }

      const updated = profiles.replace(request.params.id, merged.document);
      return { id: updated.id, name: updated.name, updatedAt: updated.updatedAt };
    },
  );

  typed.delete(
    '/api/profiles/:id',
    {
      preHandler: requireScope('apply'),
      schema: { summary: 'Delete a profile.', params: Type.Object({ id: Type.String() }) },
    },
    async (request, reply) => {
      if (store.device().activeProfileId === request.params.id) {
        return reply.status(409).send({
          error: {
            code: 'profile_active',
            message: 'The active profile cannot be deleted.',
            hint: 'Activate another profile first.',
          },
        });
      }
      if (!profiles.delete(request.params.id)) return notFound(reply, 'profile');
      store.recordEvent({ level: 'info', kind: 'profile.deleted', summary: `profile ${request.params.id} deleted` });
      return { deleted: true };
    },
  );

  /* ── export and import ──────────────────────────────────────────────────────────────────── */

  typed.get(
    '/api/profiles/:id/export',
    {
      // The default export is redacted and needs only `read`. A full one is a different route in
      // everything but the URL: it needs `admin`, and the guard below is the read one because the
      // stricter check happens inside, where the query parameter is known.
      preHandler: requireScope('read'),
      schema: {
        summary: 'Export a profile. `?secrets=include` returns the full form and is recorded as an event.',
        description:
          'The redacted export needs `read`. `?secrets=include` needs `admin` and is checked inside the ' +
          'handler, where the query parameter is known — so the guard on the route is the weaker of the two.',
        params: Type.Object({ id: Type.String() }),
        querystring: Type.Object({ secrets: Type.Optional(Type.Literal('include')) }),
      },
    },
    async (request, reply) => {
      const includeSecrets = request.query.secrets === 'include';

      if (includeSecrets && !request.auth?.scopes.includes('admin')) {
        return reply.status(403).send({
          error: {
            code: 'insufficient_scope',
            message: 'A full export including secrets needs the "admin" scope.',
            hint: 'Use the redacted export, which is the sharing format, or use an admin credential.',
          },
        });
      }

      const result = profiles.export(request.params.id, includeSecrets);
      if (result === null) return notFound(reply, 'profile');

      if (includeSecrets) {
        // Recorded as an event: reading secrets out of the device is the one operation whose whole
        // point is that it leaves with them.
        store.recordEvent({
          level: 'warn',
          kind: 'profile.exported-with-secrets',
          summary: `profile ${request.params.id} exported with secrets included`,
        });
      }

      // The last check is a human, and it runs on **both** export modes. Anything still unwrapped in a
      // tunnel configuration will leave in clear whichever mode was asked for — and in the redacted
      // mode that is worse, because the file carries a promise on its face.
      const leavingInClear = unwrappedOpaqueValues(result.document, profiles.matchersFor(result.document));

      if (leavingInClear.length > 0 && !includeSecrets) {
        store.recordEvent({
          level: 'warn',
          kind: 'profile.export-incomplete-redaction',
          summary:
            `a redacted export of ${request.params.id} carries ${leavingInClear.length} value(s) in clear ` +
            `that read as secrets: ${leavingInClear.slice(0, 5).map((entry) => `${entry.pointer} (${entry.why})`).join(', ')}`,
          detail: { pointers: leavingInClear.map((entry) => ({ pointer: entry.pointer, why: entry.why })) },
        });
      }

      return {
        document: result.document,
        secretsIncluded: result.secretsIncluded,
        leavingInClear,
      };
    },
  );

  typed.post(
    '/api/profiles/import',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Validate, migrate and store a profile document, reporting what it could not carry over.',
        // `Unknown` because an import arrives at *any* supported schema version and is brought
        // forward here; the current schema cannot describe a version-5 document. The union is
        // enforced on the migrated result at the store's write, the same door as every other write.
        body: Type.Unknown(),
      },
    },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const raw = typeof body['document'] === 'object' && body['document'] !== null ? body['document'] : body;

      let imported;
      try {
        imported = profiles.import(raw);
      } catch (error) {
        if (error instanceof ProfileVersionError) {
          return reply.status(400).send({
            error: {
              code: 'schema_version_unsupported',
              message: error.message,
              pointer: '/schemaVersion',
              hint: 'Update this device, or export the profile from a device running this version.',
              detail: { found: error.found, supported: error.supported },
            },
          });
        }
        throw error;
      }

      store.recordEvent({
        level: 'info',
        kind: 'profile.imported',
        summary: `profile "${imported.profile.name}" imported`,
        detail: { migratedFrom: imported.migratedFrom, missing: imported.missing.length },
      });

      /*
       * `activatable` is asked of the **planner**, because that is who decides it.
       *
       * It answered `missing.length === 0` — "every secret is present" — under a name that says
       * "this will run". The two came apart the moment a document could be stored that the planner
       * refuses: before the schema gate existed, an import naming `wireguard` answered 201 with
       * `activatable: true` and then failed at `/tunnels/0/protocol` the first time anybody tried.
       * The gate closes that particular door, but it cannot answer for the hardware — an unbound
       * radio, a missing binary, a channel the regulatory domain does not offer are all refusals
       * this document could still meet on this device.
       *
       * So the claim is derived from the thing it claims, rather than from a proxy that was easy to
       * reach: the document is planned, and `usable` is the planner's own word for "no finding is
       * an error". `refusals` travels beside it so the answer is checkable instead of a bare
       * boolean, and so the person is told *which* thing to go and fix.
       *
       * A plan that cannot be made at all is reported as not activatable, which is the direction
       * that costs least: telling somebody to look at a profile that would in fact have run is a
       * wasted minute; telling them it will run when it will not is what this field was doing.
       */
      let usable = false;
      let refusals: { code: string; message: string; pointer: string; hint: string }[] = [];
      try {
        const planned = await planDocument(context.pipeline, imported.profile.document as ProfileDocumentType);
        usable = planned.plan.usable;
        refusals = planned.plan.findings
          .filter((finding) => finding.severity === 'error')
          .map(({ code, message, pointer, hint }) => ({ code, message, pointer, hint }));
      } catch (error) {
        refusals = [
          {
            code: 'plan_failed',
            message: `this document was stored, and a plan for it could not be made: ${String(error)}`,
            pointer: '',
            hint: 'Open the profile and run a plan review to see what this device makes of it.',
          },
        ];
      }

      return reply.status(201).send({
        id: imported.profile.id,
        name: imported.profile.name,
        migratedFrom: imported.migratedFrom,
        migrationsApplied: imported.applied,
        // Exactly which secrets are missing. This is why a redacted export is imported rather than
        // rejected: the structure transfers, and the gaps are explicit instead of hidden.
        missingSecrets: imported.missing,
        activatable: imported.missing.length === 0 && usable,
        /** Every error the planner has about this document on this device, or an empty list. */
        refusals,
      });
    },
  );

  /* ── plan and apply ─────────────────────────────────────────────────────────────────────── */

  const planActive = async (): Promise<
    { ok: true; plan: Plan; classified: Plan2; profileId: string } | { ok: false; status: number; body: unknown }
  > => {
    const activeId = store.device().activeProfileId;
    if (activeId === null) {
      return {
        ok: false,
        status: 409,
        body: {
          error: {
            code: 'no_active_profile',
            message: 'No profile is active, so there is nothing to plan.',
            hint: 'Create a profile and activate it.',
          },
        },
      };
    }
    const profile = profiles.get(activeId);
    if (profile === null) {
      return {
        ok: false,
        status: 409,
        body: {
          error: {
            code: 'no_active_profile',
            message: 'The active profile is missing.',
            hint: 'Activate another profile.',
          },
        },
      };
    }

    // One pipeline, shared with `way revert` and the start-up sweep. Assembling these steps here as
    // well would mean a revert could plan differently from the apply it is undoing, and it would
    // differ exactly in the cases nobody tests.
    const planned = await planDocument(context.pipeline, profile.document as ProfileDocumentType);
    return { ok: true, plan: planned.plan, classified: planned.classified, profileId: activeId };
  };

  typed.get(
    '/api/plan',
    {
      preHandler: requireScope('read'),
      schema: { summary: 'The plan for the active profile, without applying anything.' },
    },
    async (_request, reply) => {
      const planned = await planActive();
      if (!planned.ok) return reply.status(planned.status).send(planned.body);
      return renderPlan(planned.plan, planned.classified);
    },
  );

  typed.post(
    '/api/apply',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Apply the active profile. Returns a transaction; `?dryRun=1` returns the plan only.',
        body: Type.Optional(ApplyBody),
        querystring: Type.Object({ dryRun: Type.Optional(Type.String()) }),
      },
    },
    async (request, reply) => {
      const planned = await planActive();
      if (!planned.ok) return reply.status(planned.status).send(planned.body);

      const { plan: result, classified } = planned;

      // A dry run is the normal path with the last step omitted, not a special mode with its own
      // risks — which is what the planner's purity buys.
      if (request.query.dryRun === '1') return { dryRun: true, ...renderPlan(result, classified) };

      // Everything from here is the transaction layer's, and it is deliberately not re-implemented
      // here: the same function serves `way revert` and the start-up sweep, so an apply and the revert
      // that undoes it cannot drift apart.
      const body = (request.body ?? {}) as { classes?: ApplyClass[] };
      const outcome = await applyDocument(context.applyDeps, {
        profileId: planned.profileId,
        document: profiles.get(planned.profileId)!.document as ProfileDocumentType,
        ...(body.classes ? { classes: body.classes } : {}),
        // Whose apply this is. Recorded on the transaction so this credential cannot expire while the
        // window it opened is counting down: nobody else can confirm it.
        openedBy: request.auth?.id ?? null,
      });

      if (!outcome.ok) {
        /*
         * A failed apply is where safe mode is decided, because this is the level the automatic action
         * should be visible from: the response says the apply failed *and* whether the device has now
         * stopped trying, which is the difference between "try again" and "go and look at it".
         *
         * Only for a refusal that actually attempted something. A validation refusal touched nothing, so
         * counting it towards safe mode would drop a device into rescue for a typo in a form.
         */
        /*
         * Only a refusal that got as far as creating a transaction counts towards safe mode. A plan
         * that was never usable — a provider this build does not have, a field that cannot be
         * satisfied — touched nothing, and counting it would drop a device into rescue over a typo in
         * a form.
         *
         * `!= null` rather than `!== null`: the field is optional, so a plan refused before any
         * transaction existed leaves it `undefined`, and comparing only against `null` treated every
         * validation refusal as an attempt. Measured on the bench board, 2026-09-20 — three refusals
         * that touched nothing each reported a safe-mode count.
         */
        const attempted = outcome.transaction != null;
        const safeMode = attempted ? await maybeEnterSafeMode(context.applyDeps, planned.profileId) : null;

        // `refused` and `steps` go inside `error.detail` as well as at the top level. The error
        // contract is what a client is guaranteed, and a client that reads only `error` — which is the
        // documented shape — would otherwise lose the list of what was refused and why, which is the
        // actionable half of this particular failure.
        const error = outcome.error!;
        return reply.status(error.status).send({
          error: { code: error.code, message: error.message, hint: error.hint, detail: error.detail },
          ...(outcome.transaction ? { transaction: outcome.transaction } : {}),
          ...(outcome.result ? { steps: outcome.result.steps, refused: outcome.result.refused } : {}),
          ...(safeMode
            ? {
                safeMode: {
                  entered: safeMode.entered,
                  failures: safeMode.failures,
                  threshold: SAFE_MODE_THRESHOLD,
                  message: safeMode.message,
                },
              }
            : {}),
        });
      }

      return {
        transaction: outcome.transaction,
        steps: outcome.result?.steps ?? [],
        refused: outcome.result?.refused ?? [],
      };
    },
  );

  /* ── confirming and reverting ───────────────────────────────────────────────────────────── */

  typed.post(
    '/api/transactions/:id/confirm',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Confirm a transaction, which stops the revert timer.',
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (request, reply) => {
      // Confirmation is an explicit act. Nothing about a client reconnecting counts, because a change
      // can restore the operator's own path while breaking everyone else's.
      const outcome = await confirmTransaction(context.applyDeps, request.params.id);
      if (!outcome.ok) {
        const error = outcome.error!;
        return reply
          .status(error.status)
          .send({ error: { code: error.code, message: error.message, hint: error.hint } });
      }
      return { transaction: outcome.transaction };
    },
  );

  typed.post(
    '/api/transactions/:id/revert',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Revert a transaction now, without waiting for its deadline.',
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (request, reply) => {
      // Reverting now rather than waiting out the window. The operator has decided, and making them
      // wait three minutes for a change they already know is wrong is downtime with no purpose.
      const outcome = await revertTransaction(
        context.applyDeps,
        request.params.id,
        // The constant, not the text: the safe-mode decision reads this exact reason to tell a change
        // of mind from a failure, and two copies of it would drift.
        REVERT_REASONS.operatorRequested,
      );
      if (!outcome.ok) {
        return reply.status(500).send({
          error: {
            code: 'revert_failed',
            message: outcome.message,
            hint: 'Read the steps. The configuration on disk may be from either document.',
            detail: { restored: outcome.restored, steps: outcome.result?.steps ?? [] },
          },
        });
      }
      return {
        reverted: true,
        target: outcome.target,
        message: outcome.message,
        // Files put back, including any that could not be: a collision needs a human and saying so
        // here is the only place it will be seen.
        restored: outcome.restored,
      };
    },
  );

  typed.get(
    '/api/transactions/:id',
    {
      preHandler: requireScope('read'),
      schema: {
        summary: 'One transaction, including `secondsRemaining` — the figure a countdown should use.',
        description:
          'Both `secondsRemaining` and `deadlineAt` are returned. Watch `secondsRemaining`: it is a duration, derived from the boot-relative deadline the revert timer acts on. `deadlineAt` is a wall-clock instant on a device with no clock battery, whose time service the apply itself restarts.',
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (request, reply) => {
      const transaction = profiles.transaction(request.params.id);
      if (transaction === null) return notFound(reply, 'transaction');
      // Neither document is returned: each is a whole profile with its secrets wrapped, and a
      // transaction view is not an export route.
      const { documentBefore, documentAfter, ...rest } = transaction;
      void documentBefore;
      void documentAfter;
      /*
       * The countdown, so a client that reconnects mid-window picks it up rather than discovering at
       * second 179 that a deadline existed — and computed from the **boot-relative** deadline the armed
       * timer acts on, not from the stored wall-clock instant. The apply that opened this window
       * restarts `systemd-timesyncd`, so the wall clock stepping inside the window is the ordinary case
       * on a board with no clock battery, and the figure sent here is the one an operator reads while
       * deciding whether their access is coming back.
       */
      const uptime = await context.platform.host.uptimeSeconds().catch(() => null);
      // Null unless the window is open: see `windowCountdown`.
      const countdown = windowCountdown(transaction, uptime, new Date());
      return { ...rest, secondsRemaining: countdown.secondsRemaining, deadlineAnchored: countdown.anchored };
    },
  );

  typed.get(
    '/api/transactions',
    { preHandler: requireScope('read'), schema: { summary: 'Recent transactions, newest first.' } },
    async () => {
      // One uptime reading for the whole list: every row's remaining time is measured against the same
      // instant, which is also what makes the list internally consistent.
      const uptime = await context.platform.host.uptimeSeconds().catch(() => null);
      const at = new Date();
      return {
        transactions: profiles.recentTransactions().map(({ documentBefore, documentAfter, ...rest }) => {
          void documentBefore;
          void documentAfter;
          const countdown = windowCountdown(rest, uptime, at);
          return { ...rest, secondsRemaining: countdown.secondsRemaining, deadlineAnchored: countdown.anchored };
        }),
      };
    },
  );

  /* ── activation ─────────────────────────────────────────────────────────────────────────── */

  typed.post(
    '/api/profiles/:id/activate',
    {
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Make a profile active. Returns a transaction, because it can change the network.',
        params: Type.Object({ id: Type.String() }),
      },
    },
    async (request, reply) => {
      const profile = profiles.get(request.params.id);
      if (profile === null) return notFound(reply, 'profile');

      const missing = profiles.missing(request.params.id);
      if (missing.length > 0) {
        // A profile cannot be activated while a secret is missing, and the answer says which ones. An
        // access point with an empty passphrase is an open network, so this is a refusal rather than a
        // best effort.
        return reply.status(422).send({
          error: {
            code: 'secrets_missing',
            message: `This profile is missing ${missing.length} secret${missing.length === 1 ? '' : 's'} and cannot be activated yet.`,
            pointer: missing[0]!.pointer,
            hint: 'Fill in the listed fields. They were removed when the profile was exported for sharing.',
            detail: { missingSecrets: missing },
          },
        });
      }

      store.recordEvent({
        level: 'info',
        kind: 'profile.activated',
        summary: `profile "${profile.name}" activated`,
      });
      context.store.setActiveProfileId(request.params.id);

      // Activation returns a transaction because it can change the network, exactly like an apply. In
      // this slice the plan that follows is what decides whether it can be carried out.
      return { activeProfileId: request.params.id, nextStep: 'POST /api/apply' };
    },
  );

  /* ── schemas and providers ──────────────────────────────────────────────────────────────── */

  typed.get(
    '/api/schemas/profile',
    {
      preHandler: requireScope('read'),
      schema: { summary: 'The JSON Schema of the profile document, which is what drives the generated forms.' },
    },
    async () => ProfileDocument,
  );

  /*
   * `GET /api/schemas/tunnel/:provider` was here, and it is **deleted rather than hidden**.
   *
   * It returned a provider's configuration schema so a generic renderer could draw a form for a
   * protocol nobody here had designed a screen for. Each catalogue entry has its own screen now, and
   * a route that keeps the old path open keeps the old product alongside the new one — which is the
   * inconsistency Epic E exists to remove rather than to relocate. The profile schema above stays:
   * it describes the document, not a way around the catalogue.
   */

  /* ── subscriptions ──────────────────────────────────────────────────────────────────────── */

  typed.post(
    '/api/subscriptions/parse',
    {
      // `apply` rather than `read`: the body is a credential-bearing blob the caller supplies, and this is
      // the route that turns it into tunnel configurations. A read-only token has no business here.
      preHandler: requireScope('apply'),
      schema: {
        summary: 'Parse a subscription document into catalogue tunnel drafts.',
        description:
          'Needs `apply` rather than `read`, because the body is a credential-bearing blob and this is the ' +
          'route that turns it into tunnel configurations. Nothing is stored: the result is a set of drafts, ' +
          'each a `{ protocol, config }` pair the profile schema accepts. A link naming a protocol this ' +
          'product does not run is reported by name, with its line, never silently skipped.',
        body: Type.Object({ text: Type.String({ maxLength: 1_000_000 }) }, { additionalProperties: false }),
      },
    },
    async (request) => {
      const result = parseSubscription(request.body.text);

      /**
       * Nodes are returned as tunnel-shaped drafts, **not** stored.
       *
       * Parsing is not importing. The caller reviews what came back, names the tunnels and decides which
       * to keep, and only then does a profile write store anything — which is also where the secret
       * wrapper goes on, derived from the catalogue entry's own schema. Storing here would put
       * credentials in the database on the strength of a paste nobody had looked at yet.
       *
       * **A draft is now `{ protocol, config }`: the pair a stored tunnel is made of.** It was
       * `{ provider: 'singbox-outbound', config: <core outbound> }`, and schema 7 has no branch for that,
       * so every draft this route produced could only be refused at the write. The parsers translate into
       * catalogue configurations and check each one against its entry's schema before returning it, which
       * is what makes the sentence below true rather than hopeful.
       *
       * The configurations contain real credentials in clear, which is unavoidable: that is what the
       * caller pasted and what they need to see in order to check it. This response is the one place that
       * is true, and it is why the route needs `apply` and why nothing here is logged.
       */
      return {
        wasBase64: result.wasBase64,
        nodes: result.nodes.map((node) => ({
          protocol: node.protocol,
          // The provider's label, for a person to recognise. Never used as an id: a label is arbitrary
          // text and an id has to satisfy the identifier rules.
          name: nodeName(node),
          scheme: node.scheme,
          config: node.config,
        })),
        // Reported, never dropped — and each refusal names the scheme it rejected *and* what this product
        // runs, because a refusal that names only the first is a riddle. A node that vanishes without a
        // word is how somebody ends up with a routing policy pointing at nothing, and the excerpt has had
        // its credentials removed.
        failures: result.failures,
      };
    },
  );

  /**
   * Named for what it walks and what it returns: the catalogue, as a list of protocols.
   *
   * It was `/api/providers` until 2026-09-21, which is the word from a registry that no longer
   * exists — five providers, four schemas and an escape hatch, all deleted in E4 (`core/providers.ts`
   * explains what survived and why the *file* keeps the old name: three modules outside that task
   * import `buildRegistry` from that path). The route kept the word and lost the concept, and **a
   * name that lies about its purpose outlives every comment explaining it**: the comment is read by
   * whoever is already in this file, the name by everyone else.
   *
   * Renameable without a deprecation window because its only client consumer was deleted with the
   * generic form it fed — `apps/ui/src/lib/api.ts` records that removal. A route nothing calls is
   * the one moment a name can be corrected for free, and the moment passes.
   */
  typed.get(
    '/api/protocols',
    {
      preHandler: requireScope('read'),
      schema: { summary: 'Every protocol in the catalogue and whether this device can run it.' },
    },
    async () => {
      const [inventory, core] = await Promise.all([
        context.inventory(),
        context.platform.binaries.coreSchema().catch(() => null),
      ]);
      let coreSchema: JsonSchemaNode | null = null;
      if (core !== null) {
        try {
          coreSchema = parseForeignSchema(core.schema);
        } catch {
          coreSchema = null;
        }
      }
      const registry = buildRegistry({
        coreSchema,
        present: new Set(inventory.binaries.filter((entry) => entry.present).map((entry) => entry.name)),
      });
      return { protocols: registry.list() };
    },
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The plan, as a client sees it.
 *
 * Paths, purposes, the classified diff and the findings. **Never file contents** — the generated core
 * configuration holds real credentials, and a plan review that printed it would defeat redaction
 * completely while looking like a safety feature.
 */
function renderPlan(result: Plan, classified: Plan2): Record<string, unknown> {
  return {
    blastRadius: classified.blastRadius,
    usable: result.usable,
    empty: classified.empty,
    humanDiff: classified.humanDiff,
    /**
     * Interfaces this plan disturbs that are carrying a management session right now.
     *
     * In the response as a field and not only inside `humanDiff`, so a script can act on it rather than
     * pattern-matching on English. A client that ignores it will lose its connection mid-apply and see
     * the device revert three minutes later, which is the correct outcome for a client that is not
     * paying attention — but it is entitled to have been told.
     */
    affectsManagementInterfaces: classified.affectsManagementInterfaces,
    findings: result.findings,
    notes: result.desired.notes,
    bindings: [...result.bindings.entries()].map(([role, resolution]) => ({ role, ...resolution })),
    files: [...result.desired.files, ...result.desired.networkFiles].map((file) => ({
      path: file.path,
      purpose: file.purpose,
      mode: file.mode.toString(8),
    })),
    units: result.desired.units.map((unit) => ({
      name: unit.name,
      enabled: unit.enabled,
      active: unit.active,
      purpose: unit.purpose,
    })),
    fileChanges: classified.fileChanges,
    unitChanges: classified.unitChanges,
    sysctlChanges: classified.sysctlChanges,
    interfaceRenames: classified.interfaceRenames,
  };
}

function notFound(reply: FastifyReply, what: string): FastifyReply {
  return reply.status(404).send({ error: { code: 'not_found', message: `no such ${what}` } });
}

/*
 * `validateDocument` was here, and it is **deleted** rather than improved.
 *
 * It was a four-key structural check — `schemaVersion`, `meta`, `network`, `firewall` — whose own
 * comment said it was deliberately shallow "*[because] Fastify compiles the same TypeBox schema for
 * request bodies*". It does not: all three write routes declared `body: Type.Unknown()`, which
 * compiles to a validator that accepts anything, so the profile union was enforced nowhere. Measured
 * over HTTP before the fix: `PUT /api/profiles/:id` with `protocol: "wireguard"` answered 200 and
 * `POST /api/profiles/import` answered 201 with `activatable: true`, for a document the planner
 * refuses at `/tunnels/0/protocol`.
 *
 * A comment claiming a check exists is worse than no comment, because it stops the next reader
 * looking — this repository has paid for that once already, at the wired uplink's static addressing.
 * So the sentence is not rewritten to be true in a weaker way: the check moved to the one door every
 * write passes through, `assertProfileDocument` in `state/profiles.ts`, and the claim can be
 * searched for by name and found, or found missing.
 */

/**
 * Values in an export that would leave in clear **and should not**. Empty when the export is safe.
 *
 * ## What this used to report, and why that was a false alarm
 *
 * It reported every non-empty string in a tunnel's configuration that was not wrapped. That was written
 * when a configuration was an opaque blob whose secrets nobody had marked, and there it was the right
 * defence. The catalogue then gave every tunnel a typed configuration with every secret marked
 * (`profile`, `auth/password`, each entry point's `uid`, the VLESS `id` and `encryption`), and from then
 * on "unwrapped" meant "an ordinary field": host names, interface suffixes, Cloak's **public** key,
 * method names. Measured on the bench board, 2026-09-24: every redacted export logged
 * `profile.export-incomplete-redaction`, "20 unwrapped value(s)", while a sentinel planted in every
 * secret position of the board's tunnel shapes comes back from the redacted export in none of them
 * (`api-profiles.test.ts`). A warning logged on every export is one nobody reads, which is how it would
 * have hidden the export that really leaked.
 *
 * ## What it reports now: a value in clear that is a secret by any of three independent readings
 *
 * * **a marked secret position holding a plain value.** Redaction wraps every marked position, so this
 *   is the machinery failing, not a field nobody marked.
 * * **a field named like a secret** (`looksLikeSecretField`: `password`, `token`, `…_key`, …) that the
 *   schema did not mark — an annotation gap.
 * * **key material in a field that is not marked**: a PEM private key, or OpenVPN's inline `<key>`,
 *   `<tls-crypt>`, `<tls-crypt-v2>`, `<tls-auth>` or `<secret>` blocks. This is the one that catches a
 *   credential pasted where nothing expected it.
 *
 * A value wrapped as `{"$secret": …}` — a full export — is excluded: that export exists to carry them.
 * The whole document is walked, not only tunnels: each reading is specific enough that a field
 * elsewhere matching it is worth the line.
 */
const KEY_MATERIAL = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|<(key|tls-crypt|tls-crypt-v2|tls-auth|secret)>/i;

export function unwrappedOpaqueValues(
  document: unknown,
  matchers: Map<string, unknown> = secretMatchers(ProfileDocument),
): { pointer: string; field: string; why: string }[] {
  const found: { pointer: string; field: string; why: string }[] = [];
  const marked = [...matchers.keys()];

  const walk = (value: unknown, pointer: string): void => {
    if (isStoredSecret(value)) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${pointer}/${String(index)}`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      // A redaction marker is a gap, not a leak: the value is already absent.
      if ('$redacted' in value || '$set' in value) return;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        walk(entry, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      }
      return;
    }
    if (typeof value !== 'string' || value === '') return;
    const field = pointer.slice(pointer.lastIndexOf('/') + 1);
    if (marked.some((matcher) => matchesPointer(matcher, pointer))) {
      found.push({ pointer, field, why: 'a position marked secret holds a value in clear' });
    } else if (looksLikeSecretField(field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))) {
      found.push({ pointer, field, why: 'named like a secret, and not marked as one' });
    } else if (KEY_MATERIAL.test(value)) {
      found.push({ pointer, field, why: 'key material in a field not marked secret' });
    }
  };
  walk(document, '');
  return found;
}

export { ErrorResponse };
