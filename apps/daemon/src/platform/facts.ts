/**
 * Facts about the running system that the invariant checks and the differ need.
 *
 * They live here because reading them means knowing what an operating system looks like, and only the
 * platform layer is allowed to know that. Everything above takes the result as plain data — which is
 * what lets each refusal below be reproduced from a fixture instead of from a board in a particular
 * state.
 *
 * Two readers here are the ones that stop this project from stepping on anything else.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './exec.ts';
import { readManaged, fileMode } from './files.ts';
import type { SystemdController } from './systemd.ts';
import type { NetReader } from './net.ts';
import { OWNED_PREFIX, PATHS } from '../core/desired-state.ts';
import type { FileState, Reality, UnitState } from '../core/differ.ts';
import { networkCidr, type RuntimeFacts } from '../core/invariants.ts';

/**
 * Units that run a proxy core and that this device did not install.
 *
 * Two cores contend for the same tunnel device and the same local ports, and the one that loses fails
 * in a way that reads as a configuration mistake. Detected by asking systemd about a small set of
 * candidate names rather than by scanning every unit: a scan on a device with 200 units is expensive,
 * and the interesting case is a distribution's own unit for the same binary.
 *
 * The candidate list is **configuration**, not a constant at the call site, because which cores exist
 * is not something this project should claim to know.
 */
export async function foreignCores(
  systemd: SystemdController,
  candidates: { unit: string; binary: string }[],
): Promise<{ unit: string; binary: string }[]> {
  const found: { unit: string; binary: string }[] = [];

  for (const candidate of candidates) {
    // Never one of ours: a unit whose name this project generated is not foreign by definition, and
    // checking it would make our own core look like a competitor.
    if (candidate.unit.startsWith('wf-')) continue;
    const state = await systemd.state(candidate.unit).catch(() => null);
    // `isActive` alone, deliberately: a core that is installed and stopped contends for nothing. The
    // existence question is answered elsewhere, for capability reporting.
    if (state?.isActive === true) found.push(candidate);
  }

  return found;
}

/**
 * Interfaces another network manager already configures, with the file that says so.
 *
 * Writing a second configuration for such an interface leaves two sources disagreeing, and the one
 * that takes effect is whichever ran last — which is the lockout shape this design exists to avoid.
 * So this is detection only: the planner refuses, and taking an interface over belongs to the epic
 * that has a confirmation window to survive it going wrong.
 *
 * The directories are given by the caller. A hardcoded list would be a claim about which distribution
 * this is running on, and the one thing this project does not do is assume the host.
 */
export async function interfaceClaims(
  directories: { path: string; by: string; extensions: string[] }[],
): Promise<{ interface: string; by: string; file: string }[]> {
  const claims: { interface: string; by: string; file: string }[] = [];

  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory.path);
    } catch {
      // A directory that does not exist is not a claim. Distinguished from a read that failed only in
      // that neither produces a claim — and that asymmetry is safe here, because the consequence of
      // missing a claim is a refusal that does not happen, not a teardown that does.
      continue;
    }

    for (const entry of entries) {
      if (!directory.extensions.some((extension) => entry.endsWith(extension))) continue;
      const file = join(directory.path, entry);
      const content = await readManaged(file).catch(() => null);
      if (content === null) continue;

      /**
       * Our own generated files are not foreign claims.
       *
       * Without this the detector reports the device's own configuration as a competitor the moment the
       * first apply writes a `.network` file into `/etc/systemd/network` — which made the *next* plan
       * carry `interface_claimed_elsewhere` as an error, so a device became un-appliable immediately
       * after its first successful apply. Found by re-planning on real hardware straight after an apply,
       * which is exactly what that check exists for.
       *
       * Recognised by the generated header rather than by file name. The header is written for precisely
       * this purpose — so a file found on a device can be traced to what wrote it — and a name pattern
       * would silently stop matching the day a generator chose a different prefix.
       */
      if (isOurs(content)) continue;

      for (const name of interfaceNamesIn(content)) {
        claims.push({ interface: name, by: directory.by, file });
      }
    }
  }

  return claims;
}

/**
 * Whether this file is one we generated.
 *
 * Matched on the header every generated file carries. Deliberately a substring test on a distinctive
 * phrase rather than an exact prefix: the header is prefixed with a comment character that differs
 * between file formats, and some generated files carry a second line before it.
 */
export function isOurs(content: string): boolean {
  return content.includes('Generated by Wayfarer');
}

/**
 * Interface names mentioned in a configuration file.
 *
 * Deliberately crude and deliberately over-inclusive. This feeds a *refusal*, and the cost of a false
 * positive is an operator being told to look at a file — annoying, and recoverable in one step. The
 * cost of a false negative is two managers configuring one interface, which is a device nobody can
 * reach. Over-inclusive is the correct side to be wrong on, and it is stated rather than implied.
 *
 * Names are matched on the shapes a configuration file uses to name one: a YAML key at any
 * indentation, a `Name=` assignment, and a quoted string. A word that merely looks like an interface
 * name in a comment will match, which is why the message names the file and lets a person judge.
 */
export function interfaceNamesIn(content: string): string[] {
  const names = new Set<string>();

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;

    // `Name=eth0` and `Name=en*`, as a link or network file writes it.
    const assignment = /^Name\s*=\s*(.+)$/.exec(line);
    if (assignment) {
      for (const value of assignment[1]!.split(/\s+/)) if (value !== '') names.add(value);
      continue;
    }

    // A YAML mapping key that is an interface name: `eth0:` or `wlan0:` under a device section.
    const key = /^([A-Za-z][A-Za-z0-9_.-]{1,14})\s*:\s*$/.exec(line);
    if (key) {
      const candidate = key[1]!;
      // Section headings are not interfaces. Listed rather than inferred, because the alternative is a
      // rule that quietly stops matching when a schema gains a key.
      const sections = new Set([
        'network',
        'ethernets',
        'wifis',
        'bridges',
        'bonds',
        'vlans',
        'tunnels',
        'modems',
        'renderer',
        'version',
        'access-points',
        'match',
        'nameservers',
        'routes',
        'dhcp4',
        'dhcp6',
        'addresses',
      ]);
      if (!sections.has(candidate)) names.add(candidate);
    }
  }

  return [...names];
}

/** Everything the invariant checks read about the running system. */
export interface FactsInput {
  systemd: SystemdController;
  net: NetReader;
  /** Candidate foreign core units, from configuration. */
  coreCandidates: { unit: string; binary: string }[];
  /** Directories another manager may configure interfaces in, from configuration. */
  claimDirectories: { path: string; by: string; extensions: string[] }[];
  /** Addresses the management interface is listening on, so its interfaces can be identified. */
  boundAddresses: string[];
  /** Binaries already detected, so this does not probe them a second time. */
  binaries: { name: string; present: boolean; version: string | null }[];
}

export async function collectFacts(input: FactsInput): Promise<RuntimeFacts> {
  const [cores, claims, snapshot] = await Promise.all([
    foreignCores(input.systemd, input.coreCandidates),
    interfaceClaims(input.claimDirectories),
    input.net.snapshot().catch(() => null),
  ]);

  // Which interfaces carry a management session: the ones holding an address the daemon is bound to.
  // Derived rather than configured, because the bind set is resolved from interface names and the
  // question here is the reverse.
  const bound = new Set(input.boundAddresses);
  const managementInterfaces =
    snapshot === null
      ? []
      : [
          ...new Set(
            snapshot.addresses
              .filter((address) => bound.has(address.address) && address.name !== 'lo')
              .map((address) => address.name),
          ),
        ];

  // The networks on the interfaces — see `interfaceNetworks` for why every one of them.
  const uplinkNetworks = snapshot === null ? [] : interfaceNetworks(snapshot.addresses);

  return {
    foreignCores: cores,
    interfaceClaims: claims,
    managementInterfaces,
    binaries: input.binaries,
    uplinkNetworks,
  };
}

/**
 * The networks on this device's interfaces, from their current addresses — the reading the core's
 * exclusion list (the fence) is built from.
 *
 * Every non-loopback IPv4 address the kernel reports is included, rather than only the ones belonging to
 * interfaces a profile calls uplinks. That is deliberate: this feeds an **exclusion**, so the cost of
 * including a network that did not need protecting is that some traffic goes direct which could have been
 * tunnelled, and the cost of omitting one is a device unreachable from the network it is plugged into.
 * Over-inclusive is the correct side to be wrong on here, and the network we serve is excluded anyway by
 * the anchor.
 *
 * The address is normalised to its network form, because `192.168.1.237/24` is a host and the exclusion
 * needs `192.168.1.0/24`. One entry per network, the first interface that holds it.
 *
 * Exported because the follower (`core/device-follower.ts`) reads the same networks the planner is
 * given, and a second copy of this rule would agree with this one until one of them changed.
 */
export function interfaceNetworks(
  addresses: { name: string; address: string; prefixLength: number; family: string }[],
): { interface: string; cidr: string }[] {
  const entries = addresses
    .filter((address) => address.family === 'inet' && address.name !== 'lo')
    .map((address) => ({
      interface: address.name,
      cidr: networkCidr(`${address.address}/${String(address.prefixLength)}`),
    }))
    .filter((entry): entry is { interface: string; cidr: string } => entry.cidr !== null);
  return [...new Map(entries.map((entry) => [entry.cidr, entry])).values()];
}

/* ── reality, for the differ ──────────────────────────────────────────────────────────────── */

export interface RealityInput {
  systemd: SystemdController;
  net: NetReader;
  paths: string[];
  units: string[];
  /** sysctl keys to read. Only the ones the plan wants to set; reading all of them is pointless. */
  sysctlKeys: string[];
  boundAddresses: string[];
}

/**
 * What the device currently looks like, for the paths and units a plan is about.
 *
 * Scoped to the plan rather than a full scan: a device has thousands of files and hundreds of units,
 * and the diff only needs the ones the plan mentions. It also means an unreadable file outside the
 * plan cannot affect the answer.
 */
export async function collectReality(input: RealityInput): Promise<Reality> {
  const files: FileState[] = await Promise.all(
    input.paths.map(async (path) => ({
      path,
      content: await readManaged(path).catch(() => null),
      mode: await fileMode(path).catch(() => null),
    })),
  );

  /**
   * Every owned unit on the device, so the differ can see one the profile no longer asks for.
   *
   * Asked of systemd rather than derived from the plan, because the whole point is to find what the
   * plan does not mention. A failure to enumerate leaves this `undefined`, which the differ treats as
   * "I could not look" rather than as "there are none" — the two must not be the same answer.
   */
  const ownedUnits = await input.systemd
    .listOwnedUnits(OWNED_PREFIX)
    .then((names) => names.filter((name) => !name.includes('@.')))
    .catch(() => undefined);

  // The plan's units and the stray ones, so the differ has state for everything it may act on.
  const wanted = [...new Set([...input.units, ...(ownedUnits ?? [])])];

  const units: UnitState[] = [];
  for (const name of wanted) {
    /*
     * Templates themselves have no state: `wf-hostapd@.service` is a file, and only its instances run.
     * So its presence is a question about the file, and the directory comes from `PATHS`.
     *
     * It was spelled out as `/etc/systemd/system` and stayed that way after generated units moved to
     * `/usr/local/lib/systemd/system`, which made `known` **always false** for every template. Latent
     * only because the differ no longer decides a template's install from that fact — and the same
     * hardcoded directory had already been found once in `classifyPath` during this epic. When a path
     * moves, the places that hardcoded it do not announce themselves.
     */
    if (name.includes('@.')) {
      const mode = await fileMode(`${PATHS.unitDir}/${name}`).catch(() => null);
      units.push({ name, active: false, enabled: false, known: mode !== null });
      continue;
    }
    const state = await input.systemd.state(name).catch(() => null);
    units.push({
      name,
      active: state?.isActive === true,
      enabled: state?.isEnabled === true,
      // Existence comes from the load state, not from the active state: a unit that does not exist
      // answers inactive/dead/not-found rather than failing, so a check based on activity calls every
      // typo a stopped service.
      known: state?.known === true,
    });
  }

  const snapshot = await input.net.snapshot().catch(() => null);
  const bound = new Set(input.boundAddresses);

  const sysctl: Record<string, string> = {};
  for (const key of input.sysctlKeys) {
    const value = await readSysctl(key);
    if (value !== null) sysctl[key] = value;
  }

  return {
    files,
    units,
    // `undefined` when systemd could not be asked, which the differ must not read as "none".
    ...(ownedUnits === undefined ? {} : { ownedUnits }),
    // Names **with their addresses**: a `.link` file matches on the address, so working out which
    // interface a rename affects means comparing addresses rather than guessing from a name list.
    interfaces: snapshot === null ? [] : snapshot.links.map((link) => ({ name: link.name, mac: link.mac })),
    managementInterfaces:
      snapshot === null
        ? []
        : [
            ...new Set(
              snapshot.addresses
                .filter((address) => bound.has(address.address) && address.name !== 'lo')
                .map((address) => address.name),
            ),
          ],
    sysctl,
  };
}

/**
 * Reads one sysctl through `/proc/sys`.
 *
 * Through the filesystem rather than the `sysctl` command, because it is one read with no process and
 * because a missing key is then an `ENOENT` rather than a message on standard error that has to be
 * distinguished from a real failure.
 */
export async function readSysctl(key: string): Promise<string | null> {
  const path = `/proc/sys/${key.replace(/\./g, '/')}`;
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Sets one sysctl. Only the reconciler calls this. */
export async function writeSysctl(key: string, value: string, sysctlPath = '/usr/sbin/sysctl'): Promise<void> {
  const result = await run(sysctlPath, ['-w', `${key}=${value}`], { timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(`could not set ${key}=${value}: ${(result.stderr + result.stdout).trim()}`);
  }
}
