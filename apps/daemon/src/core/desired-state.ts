/**
 * The desired state, and the paths and unit names this project owns.
 *
 * ## We never share a namespace with anything else on the device
 *
 * This is the decision the rest of the generation hangs off, and it is worth stating where the names
 * are defined. Configuration lives under `/etc/wayfarer/`, never in a shared include directory.
 * Units are named so ownership is legible at a glance:
 *
 * * `wayfarer.*` — installed by the installer, never generated. The daemon itself.
 * * `wf-*` — generated, and owned exclusively.
 *
 * **The reconciler may only stop, restart or delete a unit whose name it generated.** A unit it did
 * not generate is not its business, ever. That removes a whole category of accident, including the
 * one where a distro unit is adopted, the package is reinstalled, and the configuration is silently
 * replaced by the distribution's own.
 *
 * Where a program supports it, its include-directory scanning is disabled in the generated
 * configuration, so a stray file in a shared directory cannot reach our instance.
 */

export const OWNED_PREFIX = 'wf-';
export const CONFIG_ROOT = '/etc/wayfarer';

export const PATHS = {
  coreConfig: `${CONFIG_ROOT}/core/config.json`,
  firewall: `${CONFIG_ROOT}/nftables.conf`,
  hostapdDir: `${CONFIG_ROOT}/hostapd`,
  supplicantDir: `${CONFIG_ROOT}/supplicant`,
  sysctlDropIn: '/etc/sysctl.d/90-wayfarer.conf',
  dhcpDir: `${CONFIG_ROOT}/dhcp`,
  openvpnDir: `${CONFIG_ROOT}/openvpn`,
  /**
   * Where each OpenVPN client writes its status file, which carries its link receive counter — the
   * primary reading of whether its peer is alive (`core/liveness.ts`).
   *
   * **Not `/run/wayfarer/tunnel`**, where the up-script writes its captures: the resolver watch
   * (`platform/captured-resolvers.ts`) wakes on every change in that directory, and a status file
   * rewritten every five seconds per tunnel would wake it every five seconds for nothing. Created by the
   * unit template's `RuntimeDirectory=`, because OpenVPN opens the file once at start and, if the
   * directory is not there yet, writes no status for the rest of the process's life.
   */
  openvpnStatusDir: '/run/wayfarer/openvpn',
  transportDir: `${CONFIG_ROOT}/transport`,
  socksDir: `${CONFIG_ROOT}/socks`,
  networkdDir: '/etc/systemd/network',
  /**
   * The core's own cache, which is what makes a downloaded rule set survive a restart.
   *
   * Named here rather than written twice: the generator turns it on (`generate/core-config.ts`) and
   * `core/rule-set-age.ts` reads its modification time to say how old the remote sets are. Two
   * literals would be one rename away from a check that silently looks at a file nothing writes.
   *
   * Its **contents** are the core's own database in the core's own format and are never parsed here.
   */
  coreCache: '/var/lib/wayfarer/core-cache.db',
  /**
   * The record of which networks in the core's exclusion list were **followed** — handed to one of our
   * tunnel interfaces by a peer — when that list was written. Nothing runs from it; the differ reads
   * it back to decide whether a network leaving the running fence may leave without a window. See
   * `onlyFollowedNetworksMoved`.
   *
   * Deliberately **not** under `core/`: the restart-cause net restarts `wf-core` for any changed path
   * containing `/core/`, and the core does not read this file.
   */
  coreFence: `${CONFIG_ROOT}/fence.json`,
  /**
   * Generated units go under `/usr/local/lib`, **not** `/etc/systemd/system`.
   *
   * Measured on the bench board, and it disabled the safety net completely:
   *
   * ```
   * # systemctl mask --now wayfarer
   * Failed to mask unit: File '/etc/systemd/system/wayfarer.service' already exists
   * ```
   *
   * systemd masks a unit by creating a symlink to `/dev/null` **at** `/etc/systemd/system/<unit>`. A unit
   * file written to that same path occupies the location a mask needs, so masking is refused — and the
   * deadman's central action, taking our software out of the boot path, silently did not happen. The
   * board rescued itself, came back, and locked itself out again because the unit it thought it had
   * masked started normally.
   *
   * `/etc/systemd/system` is the **administrator's** directory: it is where an operator drops overrides
   * and where systemd puts masks. Software that installs its own units there is squatting on the one
   * place reserved for the person who has to fix it. `/usr/local/lib/systemd/system` is the correct home
   * for locally installed units, it is searched at lower precedence, and it leaves both overriding and
   * masking available — which is exactly the point.
   */
  unitDir: '/usr/local/lib/systemd/system',
} as const;

/**
 * The single nftables table this project owns.
 *
 * Everything generated goes in here, and the ruleset deletes and recreates **only this table**.
 * Never a ruleset flush: measured on the bench board, the live ruleset holds four tables and at
 * least two belong to other software — a proxy core creates its own when it manages redirection, and
 * a global flush removes it, silently disabling tunnelling on any restart of the firewall.
 */
export const OWNED_TABLE = { family: 'inet', name: 'wayfarer' } as const;

/**
 * What reads a generated file.
 *
 * **Every artefact must name its consumer**, and the planner refuses to emit one that names a unit it
 * did not also generate. This exists because of a fault that was invisible to every check we had: the
 * firewall ruleset was generated, written, diffed and shown in the plan review, and **nothing ever
 * loaded it** — so a device that had applied a profile and been power-cycled had no kill-switch, no
 * IPv6 rejection and no management-port rules, while every file on disk said it did.
 *
 * The `is-active` and `is-enabled` discipline could not catch it, because that discipline starts from
 * units and this was a file with no unit. An orphan artefact is a file documenting an intention the
 * system does not have, and a plan review that shows it makes the lie more convincing rather than
 * less.
 *
 * Three kinds, because not every artefact is read by a unit of ours and pretending otherwise would
 * make the check a formality:
 *
 * * `unit` — a `wf-*` unit whose command line names this path. Checked: that unit must exist in the
 *   same desired state.
 * * `external` — read by software this project does not own, named so a reader can go and look.
 *   `systemd` reads unit files; `systemd-networkd` reads `.network` and `.link` files.
 * * `reader` — for a person. The directory README is the only one, and it says so.
 */
export type ArtefactConsumer =
  | { kind: 'unit'; unit: string }
  | { kind: 'external'; by: string }
  | { kind: 'reader'; by: string };

export interface ManagedFile {
  path: string;
  content: string;
  mode: number;
  uid?: number;
  gid?: number;
  /** What this file is for, in the plan review. */
  purpose: string;
  /** What reads it. See `ArtefactConsumer`: an artefact nobody consumes is refused. */
  consumedBy: ArtefactConsumer;
  /**
   * True when this file's **content depends on what was discovered about the device's surroundings**
   * — addresses, the networks the interfaces are on — rather than on the profile alone.
   *
   * The boot guard re-derives exactly these, and it finds them by this mark. The mark exists here,
   * beside the generator, rather than as a list of paths somewhere else, because a list is a copy and
   * a copy stops matching the thing it copies. A hand-written allowlist would silently fail to
   * re-derive the next environment-dependent artefact somebody adds, and the symptom would be a board
   * unreachable after a reboot on a new network — the precise defect the guard exists to prevent,
   * reintroduced through the guard's own blind spot.
   *
   * A new artefact is therefore either marked or deliberately not marked, rather than forgotten.
   */
  environmentDependent?: boolean;
  /**
   * **This file's contents are credentials**, so a divergence in it names the file — and for JSON the
   * pointer — and never prints a value or a line.
   *
   * Set by the generator, because the generator is the only code that knows what it wrote: an `.ovpn`
   * blob with a private key and a `tls-crypt` key inline, a `hostapd` passphrase, a supplicant's
   * network key. Deciding it from the path would be a second list that stops matching the first, and
   * deciding it from the mode was tried and rejected — every generated file is `0600`, including the
   * core configuration the drift check exists to compare value by value, so the mode separates
   * nothing (`docs/13-plan.md` row G12). `catalogue-secrets.test.ts` plans every catalogue entry with
   * a sentinel in each credential field and fails if the sentinel lands in a file without this mark.
   */
  credentials?: boolean;
  /**
   * Places in this JSON file whose value was **read off the running device** when the file was
   * generated — a captured resolver, the networks the interfaces are on — rather than derived from
   * the profile alone.
   *
   * The drift check re-derives now and compares with what was written then, so a difference at one of
   * these pointers is a reading that has moved, not a profile the device is not running, and it says
   * so. `unordered` marks a list whose order carries no meaning, which is compared as a set: compared
   * by index, one element shifting makes every later position a "difference".
   */
  observed?: ObservedPointer[];
}

export interface ObservedPointer {
  /** A JSON Pointer into this file. */
  pointer: string;
  /** What was read, in the words a finding will use. */
  from: string;
  unordered: boolean;
}

export interface DesiredUnit {
  name: string;
  enabled: boolean;
  active: boolean;
  /** Unit file content, for the units this project ships rather than the ones it only drives. */
  content?: string;
  purpose: string;
}

/**
 * A validation to run before anything is written. Ordered cheapest first by the reconciler, which is
 * the only place this is executed — a check is data here, not a call.
 */
export type DesiredCheck =
  | { kind: 'nft-check'; ruleset: string }
  | { kind: 'core-check'; configPath: string }
  | { kind: 'unit-not-foreign'; units: string[] }
  /**
   * Every directory this plan intends to write into or move a file within, checked **before** anything
   * starts.
   *
   * This exists because of a failure that got further than it should have: a takeover was planned,
   * accepted, given a transaction, given a confirmation window and a revert timer, and then attempted —
   * at which point it failed with `EROFS` on `/etc/netplan`, a directory the daemon's sandbox had never
   * allowed it to write. The permission was knowable before the first byte moved.
   *
   * The general form is the real fix, and the specific missing path is only today's symptom: **a sandbox's
   * writable set and a planner's intentions are two descriptions of what we may touch, and they will drift
   * again.** So the plan states every directory it needs and the reconciler proves each one is writable,
   * rather than discovering it halfway through.
   */
  | { kind: 'paths-writable'; directories: { path: string; why: string }[] };

/**
 * A claim on an interface that another network manager holds, and which this plan intends to clear.
 *
 * Planned as data rather than performed by the planner, like everything else here. The reconciler
 * moves the file aside — **never deletes it** — and records the move on the transaction, so a revert
 * inside the confirmation window can put it back. There is no way to express "somebody else's file was
 * disabled" in a profile document, and a revert re-applies a document, so the record has to live with
 * the transaction whose window it belongs to.
 */
export interface PlannedTakeover {
  /** The file holding the claim. */
  path: string;
  /** Which manager it belongs to, in words, for the plan review. */
  by: string;
  /** The interface it claims, so a review says what is being taken over rather than only from where. */
  interfaceName: string;
}

/**
 * What the planner produces. Pure data: no handles, no promises, nothing that has touched the
 * system. This is what makes a dry run free and the planner testable on a workstation.
 */
/**
 * An interface this plan configures, and the condition that means it has settled.
 *
 * `address` for a link we give a static address to and which something else brings up afterwards — an
 * access point, whose carrier appears only once the radio is hosting. `carrier-and-address` for a link
 * that has to be genuinely connected to be useful, such as a DHCP uplink.
 */
export interface ManagedInterface {
  name: string;
  expect: 'address' | 'carrier-and-address';
}

/**
 * One planned tunnel's units, and the interfaces it creates.
 *
 * `interfaces` is here because the watchdog needs a tunnel's own interface to measure it against the
 * address its peer pushed (`core/watchdog.ts`, `guardedTunnels`), and the name is made by the catalogue
 * — a second copy of that naming rule at the point of use is the defect this project avoids. Empty for
 * a tunnel carried through a local client (VLESS, a proxy), which is what keeps such a tunnel out of
 * any default derived from an interface. Optional on the wire because records written before it had none.
 */
export interface TunnelUnitsEntry {
  id: string;
  units: string[];
  interfaces?: string[];
}

export interface DesiredState {
  files: ManagedFile[];
  units: DesiredUnit[];
  /** `.network` and `.link` files, kept apart from `files` because they need `networkctl reload`. */
  networkFiles: ManagedFile[];
  checks: DesiredCheck[];
  /**
   * Interfaces this state expects to exist once it is applied, including ones a tunnel daemon will
   * create. The invariant checks that care about names and collisions need to see these too.
   */
  interfaces: string[];
  /**
   * The interfaces the management surface may be reached on, as **resolved** names.
   *
   * Carried on the desired state because only the plan knows them: the profile names a radio and a role,
   * and what comes out is `wlan1` or `wfwan0` or `wlx90de8047b4b4`. The daemon records these after a
   * successful apply so the listener binds what was actually resolved rather than what was expected — an
   * earlier version derived the names from the profile and produced `wfwan0` for an uplink that had
   * resolved to `wlan0`, so it was never bound and nothing said why.
   *
   * The uplinks here are the ones that resolved, unfiltered by the management setting. The filter is
   * applied when they are read, so turning the setting off takes effect on the next address change instead
   * of needing an apply.
   */
  managementSurfaces: {
    accessPoint: string | null;
    uplinks: string[];
    /**
     * The interfaces this plan's own tunnels create, as **resolved** names.
     *
     * Recorded for the same reason as the two above, and against the same failure: the names are
     * derived here, from a provider's emission and the generated-name rules in `binding.ts`, and a
     * consumer that needed them had only two options — go without, or copy the naming convention
     * (including how `config.interfaceSuffix` is read) into itself. Two copies of a convention agree
     * exactly until the day one of them changes.
     *
     * **A list that arrives empty means "this plan created no tunnel interfaces", not "unknown".** A
     * record written before this field existed also reads as empty, which is safe only because every
     * consumer treats this as a *supplement*: the verdict on whether an interface is a tunnel is taken
     * from the link's own shape first, and this list adds the cases a link cannot reveal.
     */
    tunnels: string[];
  };
  /**
   * The units each of this plan's tunnels is made of, by tunnel id.
   *
   * Recorded here for the reason the tunnel interface names above are recorded: the unit names come
   * from per-protocol rules in `core/catalogue/`, and a consumer that needed them had only two
   * options — go without, or copy the naming rule into itself. Two copies of a convention agree
   * exactly until the day one of them changes.
   *
   * **A tunnel is not one unit.** An OpenVPN tunnel has one; the same tunnel behind an obfuscation
   * transport has a second; a VLESS tunnel has its client. That is why this is a list per tunnel and
   * not a name per tunnel, and why every consumer has to state its own rule for combining them.
   *
   * **An empty outer list means "this plan has no tunnels", not "unknown"** — the same reading as
   * `managementSurfaces.tunnels`, and safe here for a different reason: the only consumer reports
   * `null` until it has read something, so "no tunnels planned" and "nobody has looked" stay apart
   * on the wire rather than here.
   */
  tunnelUnits: TunnelUnitsEntry[];
  /**
   * The two kinds of network this file's reachability classification turns on.
   *
   * `followed` are networks a **peer** assigned to an interface one of this plan's tunnels created.
   * The far end hands out the transfer subnet and may hand out a different one on every
   * reconnection; measured on the bench board, 2026-09-21, one tunnel moved from `10.164.0.0/20` to
   * `10.165.0.0/20` between two reconnections an hour apart. We do not defend these — we follow them.
   *
   * `defended` are the networks whose exclusion is what keeps this device **reachable**: the served
   * LAN, the tunnel transfer network we choose ourselves, and the networks of the interfaces the
   * device is actually reached through.
   *
   * Recorded here because the differ needs both and can derive neither: it sees two JSON documents
   * and has no way to tell a network a peer moved from a network that keeps the board answering.
   * See `classifyContentChange`, its only consumer.
   *
   * **Every address the generator puts in the exclusion list is in exactly one of these**, which is
   * asserted by a test rather than promised here — an address in neither would be the one way this
   * could fail unsafely. Both arriving empty means "nothing was read off this device", not
   * "unknown", and leaves every change classified exactly as it was before this existed.
   */
  reachabilityNetworks: { followed: string[]; defended: string[] };
  /** sysctl settings, applied between the network configuration and the firewall. */
  sysctl: { key: string; value: string; reason: string }[];
  /**
   * Foreign claims this plan will clear, and the interfaces they hold.
   *
   * Empty unless the profile explicitly asked for a takeover. The default is to refuse, because
   * writing a second configuration for an interface another manager owns leaves two sources
   * disagreeing and the one that wins is whichever ran last.
   */
  takeover: PlannedTakeover[];
  /**
   * Interfaces whose addressing this plan changes, and **what settling means for each**.
   *
   * Named rather than "all of them": `networkctl reconfigure` across everything would touch
   * interfaces this device does not manage, which is the same boundary violation as acting on a unit
   * we did not generate.
   *
   * The expectation is per interface because a single definition of "up" is wrong for half of them.
   * Measured on the bench board: an access-point interface has **no carrier until hostapd starts**, and
   * hostapd starts later in the apply order — so waiting for a carrier there waits the full timeout
   * every time, reports "not settled" about a perfectly healthy interface, and adds twenty seconds to
   * every apply. The `.network` file already says `RequiredForOnline=no` for exactly this reason.
   */
  managedInterfaces: ManagedInterface[];
  /** Anything the operator should read before applying, carried through to the plan review. */
  notes: string[];
}

export function emptyDesiredState(): DesiredState {
  return {
    files: [],
    units: [],
    networkFiles: [],
    checks: [],
    interfaces: [],
    managementSurfaces: { accessPoint: null, uplinks: [], tunnels: [] },
    tunnelUnits: [],
    reachabilityNetworks: { followed: [], defended: [] },
    sysctl: [],
    takeover: [],
    managedInterfaces: [],
    notes: [],
  };
}

/** True when this project generated the name, and may therefore act on the unit. */
export function isOwnedUnit(name: string): boolean {
  return name.startsWith(OWNED_PREFIX);
}

/**
 * The generated-file header.
 *
 * Every generated file says what wrote it and that edits are lost, because the alternative is
 * somebody editing one by hand, watching it revert on the next apply, and concluding the software is
 * broken. It also names the profile, so a file found on a device can be traced to a document.
 */
export function generatedHeader(comment: string, profileName: string): string {
  return (
    `${comment} Generated by Wayfarer from the profile "${profileName}".\n` +
    `${comment} Edits here are overwritten on the next apply. Change the profile instead.\n`
  );
}

/**
 * Artefacts that name a unit nobody generated, or that name nothing at all.
 *
 * Pure, and returned as data so the planner can turn each into a finding with a pointer. The check is
 * cheap; what it buys is that the class of fault it covers becomes unrepresentable rather than
 * unlikely — a generator that starts emitting a new kind of file has to say what reads it, and if the
 * answer is "a unit I forgot to add", this says so before the file reaches a device.
 */
export function orphanArtefacts(desired: DesiredState): { path: string; reason: string }[] {
  const generated = new Set(desired.units.map((unit) => unit.name));
  const orphans: { path: string; reason: string }[] = [];

  for (const file of [...desired.files, ...desired.networkFiles]) {
    const consumer = file.consumedBy;
    if (consumer.kind !== 'unit') continue;
    if (generated.has(consumer.unit)) continue;
    orphans.push({
      path: file.path,
      reason:
        `it names ${consumer.unit} as the unit that reads it, and this plan does not generate that ` +
        'unit. The file would be written and nothing would ever load it.',
    });
  }

  return orphans;
}
