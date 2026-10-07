/**
 * Whether a resolver a peer pushed has actually reached the core's configuration.
 *
 * One question, asked in two places, which is why it is a module rather than a line in each:
 *
 * * **before** re-deriving — is what the peers have pushed already in the file the core reads? If it
 *   is, there is nothing to do; if it is not, something must happen — and it must keep being asked,
 *   every round, until it happens. See `core/resolver-follower.ts`.
 * * **after** re-deriving — did the write land? The apply reports refusals, and Epic E made a refusal
 *   stop the success. But an apply that refused nothing and also *wrote* nothing looked exactly like
 *   an apply that worked, because nothing read the result back. See `api/resolver-reconverge.ts`.
 *
 * ## Measured on the bench board, 2026-09-22
 *
 * `dns.dynamic` was true for the hq tunnel, `/run/wayfarer/tunnel/hq.dns` held `10.184.100.5`,
 * and `/etc/wayfarer/core/config.json` named `10.184.40.5` — the profile's stale starting point.
 * `wplan.hq.lan` stopped resolving for every client on the network. The tunnel was healthy
 * throughout, so nothing else looked wrong, and `resolver.reconverged` had been recorded twice while
 * that file's mtime never moved. This is the comparison that would have said so in one line.
 *
 * ## Why the answer is read out of the generated file rather than tracked in memory
 *
 * A variable holding "the resolver we last wrote" is a second copy of a fact whose original is on
 * disk, and the two part company at the first write that did not happen — which is precisely the
 * event being detected. The file the core reads is the only statement of what the core was told.
 */

import { tunnelDnsTag } from './generate/core-config.ts';
import type { ProfileDocument } from '@wayfarer/schemas';

/** A tunnel whose resolver address is the peer's to choose. */
export interface DynamicResolverTunnel {
  id: string;
  name: string;
  /** The profile's value, which for a dynamic resolver is a starting point rather than a setting. */
  profileServer: string;
}

export function dynamicResolverTunnels(document: ProfileDocument): DynamicResolverTunnel[] {
  return document.tunnels
    .filter((tunnel) => tunnel.enabled && tunnel.dns?.dynamic === true)
    .map((tunnel) => ({ id: tunnel.id, name: tunnel.name, profileServer: tunnel.dns?.server ?? '' }));
}

/**
 * The resolver address the core's configuration names for each tunnel, by tunnel id.
 *
 * `null` for a document that cannot be read or parsed, which is **not** the same as a document that
 * names no resolvers. "I could not read it" must not be reported as "the captured value is not
 * there", and it must never be reported as "the captured value is there" either: both are claims,
 * and the caller is given the absence so it can say so.
 */
export function resolversInCoreConfig(text: string | null): Map<string, string> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const dns = (parsed as { dns?: { servers?: unknown } } | null)?.dns;
  if (dns === undefined || dns === null || !Array.isArray(dns.servers)) return null;

  const byTag = new Map<string, string>();
  for (const entry of dns.servers as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const tag = (entry as { tag?: unknown }).tag;
    const server = (entry as { server?: unknown }).server;
    if (typeof tag === 'string' && typeof server === 'string') byTag.set(tag, server);
  }
  return byTag;
}

/** One tunnel whose captured resolver is not the one the core was given. */
export interface ResolverDivergence {
  tunnelId: string;
  tunnelName: string;
  /** What the peer pushed and the up script captured. */
  captured: string;
  /** What `config.json` names for that tunnel, or `null` when it names nothing or could not be read. */
  inCore: string | null;
}

export interface DivergenceInput {
  tunnels: DynamicResolverTunnel[];
  /** What the up script has captured, by tunnel id. */
  captured: Map<string, string>;
  /** The generated core configuration as it is on disk, or `null` if it could not be read. */
  coreConfig: string | null;
}

/**
 * The tunnels whose captured resolver is not in the core's configuration.
 *
 * Empty means every captured resolver is in use — the only statement that deserves to be called a
 * convergence. A tunnel with nothing captured is not listed: there is nothing to converge on, the
 * planner already raises `dynamic_resolver_uncaptured` for it, and a "divergence" nobody can fix is
 * an alarm that trains people to ignore alarms.
 *
 * A configuration that could not be read or parsed makes **every** dynamic tunnel with a capture
 * diverge, with `inCore: null`. An unreadable file is not evidence that the value landed.
 */
export function resolverDivergence(input: DivergenceInput): ResolverDivergence[] {
  const inCore = resolversInCoreConfig(input.coreConfig);
  const divergent: ResolverDivergence[] = [];

  for (const tunnel of input.tunnels) {
    const captured = input.captured.get(tunnel.id);
    if (captured === undefined || captured === '') continue;
    const named = inCore?.get(tunnelDnsTag(tunnel.id)) ?? null;
    if (named === captured) continue;
    divergent.push({ tunnelId: tunnel.id, tunnelName: tunnel.name, captured, inCore: named });
  }

  return divergent;
}

/** The divergences, phrased for a person: which tunnel, what was pushed, what the core was told. */
export function describeDivergence(divergent: ResolverDivergence[]): string {
  return divergent
    .map(
      (entry) =>
        `"${entry.tunnelName}" captured ${entry.captured} but the core is configured with ` +
        `${entry.inCore ?? 'no resolver of its own'}`,
    )
    .join('; ');
}

/**
 * Both sides of the question, read fresh: what the peers pushed, and what the core's file names.
 *
 * Moved out of `index.ts`, where it was a closure `main()` owned and no test could reach — the
 * condition that let the follower it serves fail for ten hours without a red test anywhere.
 */
export async function readConvergence(
  document: ProfileDocument,
  readers: { captured: () => Promise<Map<string, string>>; coreConfig: () => Promise<string | null> },
): Promise<{
  readable: boolean;
  divergent: ResolverDivergence[];
  inUse: { tunnelId: string; address: string }[];
  captured: Map<string, string>;
}> {
  const captured = await readers.captured();
  const text = await readers.coreConfig().catch(() => null);
  const named = resolversInCoreConfig(text);
  const tunnels = dynamicResolverTunnels(document);
  return {
    readable: named !== null,
    divergent: resolverDivergence({ tunnels, captured, coreConfig: text }),
    inUse: tunnels.flatMap((tunnel) => {
      const address = named?.get(tunnelDnsTag(tunnel.id));
      return address === undefined ? [] : [{ tunnelId: tunnel.id, address }];
    }),
    captured,
  };
}
