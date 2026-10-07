/**
 * The one path from a profile document to a classified plan.
 *
 * This exists because there are now **three** callers that must plan identically: the API, the
 * operator CLI running `way revert` in a fresh process, and the sweep at daemon start that reverts an
 * unconfirmed transaction. `docs/06-apply-and-rollback.md` says reverting goes "through exactly the
 * same planner and reconciler", and the only way to make that true rather than aspirational is for
 * there to be one function and no second assembly of the same steps.
 *
 * It was previously inline in the API route. That was correct while the API was the only caller and
 * became a latent defect the moment a revert had to happen without it — a revert planned by slightly
 * different code is a revert that can disagree with the apply it is undoing, and it would disagree
 * exactly in the cases nobody tests.
 *
 * **This is an orchestrator, not the planner.** It reads (the inventory, the running system, the
 * core's schema) and calls pure code. It performs no mutation: that is still the reconciler's alone.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import { createValidatorCache, parseForeignSchema, type JsonSchemaNode } from '@wayfarer/protocols';
import type { Platform } from '../platform/index.ts';
import type { Inventory } from '../inventory/index.ts';
import { plan as computePlan, type Plan } from './planner.ts';
import { diff, type Plan2, type Reality } from './differ.ts';
import type { RuntimeFacts } from './invariants.ts';
import { emitTunnels, validateTunnelConfigs } from './emit.ts';
import { coreCapabilitiesOf } from './providers.ts';
import { PATHS, type ManagedFile, type TunnelUnitsEntry } from './desired-state.ts';
import { readFenceRecordEntries, type FollowedEntry } from './followed-networks.ts';

/**
 * Compiled validators, kept for the life of the process.
 *
 * Compiling a 445 KB schema is not free on a four-core Cortex-A53, and the schema changes only when
 * the binary does — which cannot happen under a running process.
 */
const validators = createValidatorCache();

export interface PipelineContext {
  platform: Platform;
  inventory: () => Promise<Inventory>;
  /** Facts about the running system the invariant checks read. Gathered by the caller, used purely. */
  facts: () => Promise<RuntimeFacts>;
  /** Reality for exactly the paths, units and sysctl keys this plan is about. */
  reality: (paths: string[], units: string[], sysctlKeys: string[]) => Promise<Reality>;
  managementPort: number;
  timePorts: number[];
  upScriptPath: string;
  /**
   * Resolver addresses captured from peers, by tunnel id. A runtime reading, supplied by the caller so
   * the pipeline stays pure — the same treatment as the uplink networks and for the same reason.
   */
  capturedResolvers?: () => Promise<Map<string, string>>;
  /** The operator CLI as a unit can execute it; see the planner input. */
  wayBinary: string;
  /**
   * Called with the management surfaces every plan resolves, so the listener can bind what resolved.
   *
   * Hooked at **plan** time rather than at apply time, and that is the whole point of it being here. The
   * names are a fact about this profile against this hardware, not about a change — and recording them only
   * on apply left a device that was already converged with nothing recorded and no way to get it, because
   * there was nothing to apply. A plan happens on every dry run, every apply, every revert and every boot
   * re-derivation, so the value is refreshed by ordinary use.
   *
   * Optional, because the planner is pure and a test plans without a device to record into.
   */
  /**
   * Called with every plan's resolved surfaces, including the interfaces its own tunnels create.
   *
   * `tunnels` is part of the shape rather than an optional extra: a caller that may omit it is a caller
   * that will, and the value of recording these names at all is that nobody has to re-derive them from
   * the naming convention.
   */
  onManagementSurfaces?: (surfaces: {
    accessPoint: string | null;
    uplinks: string[];
    tunnels: string[];
  }) => void;
  /**
   * Called with the units each of this plan's tunnels is made of.
   *
   * Separate from `onManagementSurfaces` rather than folded into it, because these units are not a
   * management surface: nothing binds to them and nothing about reachability turns on them. Folding
   * them in would have saved a callback and taught the next reader that a tunnel's transport unit is
   * somewhere the panel can be reached.
   */
  onTunnelUnits?: (tunnelUnits: TunnelUnitsEntry[]) => void;
}

export interface PlannedDocument {
  plan: Plan;
  classified: Plan2;
  /**
   * The reading of the device the classification was made against.
   *
   * Returned rather than discarded because the drift check has to name **both values** — what the
   * profile says and what the device holds — and the second one only exists here. Recovering it by
   * reading the same paths again would be a second reading taken a moment later, which is the precise
   * error the catalogue records as *a measurement is only valid for as long as the thing measured
   * stays put*: the report would then describe a device assembled from two different instants.
   */
  reality: Reality;
}

/**
 * Plans one document against this device, and classifies the difference.
 *
 * The document is a parameter rather than "the active profile", which is what lets a revert plan the
 * document it is going back to through this same function. A caller that wants the active profile
 * looks it up and passes it.
 */
export async function planDocument(context: PipelineContext, document: ProfileDocument): Promise<PlannedDocument> {
  const [inventory, facts, core] = await Promise.all([
    context.inventory(),
    context.facts(),
    // A schema that cannot be fetched is not a reason to fail, and it is not a reason to wait. It
    // narrows availability discovery and nothing else; absent knowledge is not a negative answer.
    context.platform.binaries.coreSchema().catch(() => null),
  ]);

  let coreSchema: JsonSchemaNode | null = null;
  if (core !== null) {
    try {
      coreSchema = parseForeignSchema(core.schema);
    } catch {
      // The schema is *input*, from a binary we do not control. Input must fail cleanly.
      coreSchema = null;
    }
  }

  // Read once per plan, before generation, so the same values are used throughout one pass.
  const capturedResolvers = await context.capturedResolvers?.();

  /*
   * **One reading, handed to both consumers.**
   *
   * It was computed inline for `emitTunnels` and simply left out of `computePlan` below, and this is
   * the only caller of `computePlan` in `src`. So every production plan ran the invariant checks
   * with `core` absent, which they read as `known: false` — and `known: false` means *assume
   * everything is offered*, on purpose, so that a missing binary cannot block configuration. The
   * result was that `protocol_unavailable` and `binary_missing` could never fire on a real device: a
   * tunnel enabled on a core that does not speak its protocol produced no finding, and the daemon
   * wrote a configuration the core rejects.
   *
   * Nothing went red, because every test of those checks calls `checkInvariants` directly with an
   * explicit `core` and none of them came through this file. A named value used twice rather than
   * two calls, so the next consumer joins the same reading instead of adding a third that can be
   * forgotten.
   */
  const coreCapabilities = coreCapabilitiesOf(coreSchema);

  const emitted = emitTunnels({
    profile: document,
    // Availability discovery only. No catalogue entry plans from the core's schema: a carrier
    // decision that waited on a fetch would be a configuration that cannot be written down while a
    // binary is missing, which is the defect this epic removes elsewhere.
    core: coreCapabilities,
    installed: new Set(inventory.binaries.filter((entry) => entry.present).map((entry) => entry.name)),
    allocatedPorts: new Set(),
  });

  // The running fence's record of what in it is followed: those networks are retained while merely
  // absent (`core/followed-networks.ts`). Unreadable is no record, which retains nothing.
  const retained = readFenceRecordEntries(await readQuietly(() => context.platform.files.readManaged(PATHS.coreFence)));

  const planWith = (retainedFollowed: FollowedEntry[] | undefined): Plan =>
    computePlan({
      profile: document,
      inventory,
      facts,
      core: coreCapabilities,
      // Cheapest first: a schema pass with a pointer into the profile, before the object is embedded and
      // long before the core is asked to run the assembled file.
      tunnelIssues: validateTunnelConfigs({ profile: document, validators }),
      emissions: emitted.emissions,
      ports: emitted.ports,
      refusals: emitted.refusals,
      carriers: emitted.carriers,
      managementPort: context.managementPort,
      timePorts: context.timePorts,
      coreBinaryPath: inventory.binaries.find((entry) => entry.name === 'sing-box')?.path ?? null,
      upScriptPath: context.upScriptPath,
      ...(capturedResolvers === undefined ? {} : { capturedResolvers }),
      ...(retainedFollowed === undefined ? {} : { retainedFollowed }),
      wayBinary: context.wayBinary,
    });

  let result = planWith(retained);

  const reality = await context.reality(
    [...result.desired.files, ...result.desired.networkFiles].map((file) => file.path),
    result.desired.units.map((unit) => unit.name),
    // Derived from the desired state, never from a list a caller keeps. A key the generator emits and
    // nobody reads is a difference that can never be resolved, and every plan would then be `network`.
    result.desired.sysctl.map((setting) => setting.key),
  );

  /*
   * **When a retained network leaves.** Only when the core's configuration is being rewritten for a
   * reason other than values read off the device — a change somebody made. Then the core restarts
   * anyway, and dropping what is stale costs nothing more. Otherwise — the device already running this,
   * or a follower adding a network or a resolver — it stays, because removing it would be a restart of
   * its own, once per tunnel flap. Every caller plans through here, so the apply, the follower, the
   * revert and the drift check all answer "is this in step?" by the same rule.
   */
  if (retained !== undefined && retained.length > 0) {
    const lean = planWith(undefined);
    const withRetained = coreFileOf(result);
    const without = coreFileOf(lean);
    if (withRetained !== null && without !== null && withRetained.content !== without.content) {
      const running = reality.files.find((file) => file.path === PATHS.coreConfig)?.content ?? null;
      if (!differsOnlyInObserved(withRetained, running)) result = lean;
    }
  }

  // The resolved names, handed to the caller. The planner stays pure; only this notification leaves it.
  context.onManagementSurfaces?.(result.desired.managementSurfaces);
  context.onTunnelUnits?.(result.desired.tunnelUnits);

  return { plan: result, classified: diff({ desired: result.desired, reality }), reality };
}

async function readQuietly(read: () => Promise<string | null>): Promise<string | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function coreFileOf(result: Plan): ManagedFile | null {
  return result.desired.files.find((file) => file.path === PATHS.coreConfig) ?? null;
}

/**
 * Whether the running core configuration is this derivation, but for values read off the device.
 *
 * The marks come from the generator (`ManagedFile.observed`): the fence, the direct rule over the same
 * networks, and each captured resolver. Both documents have those locations removed and are then
 * compared whole. Unreadable or unparseable is `false` — "I could not tell" must not keep a network
 * nobody asked to keep.
 */
export function differsOnlyInObserved(derived: ManagedFile, running: string | null): boolean {
  if (running === null) return false;
  let left: unknown;
  let right: unknown;
  try {
    left = JSON.parse(derived.content);
    right = JSON.parse(running);
  } catch {
    return false;
  }
  for (const mark of derived.observed ?? []) {
    removeAt(left, mark.pointer);
    removeAt(right, mark.pointer);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeAt(document: unknown, pointer: string): void {
  const segments = pointer.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  const last = segments.pop();
  if (last === undefined) return;
  let node: unknown = document;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return;
    node = (node as Record<string, unknown>)[segment];
  }
  if (node !== null && typeof node === 'object') (node as Record<string, unknown>)[last] = null;
}
