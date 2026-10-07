/**
 * The planner: `profile + inventory → DesiredState`, and nothing else.
 *
 * **Pure.** No I/O, no clock, no randomness, no environment. Everything it needs that is not in the
 * profile arrives in the input, including the runtime facts the invariant checks read. That is what
 * makes a dry run free and lets every case be covered by a synthetic inventory instead of by a board
 * in a particular state — and it is the property a reviewer should check first, because it is easy to
 * lose one call at a time.
 *
 * The planner **plans everything**, including the parts of a configuration this epic's reconciler
 * will not apply. Refusing to plan a network change would mean the operator could not see a diff for
 * it, and a diff nobody can see is a change nobody can review before it happens.
 */

import { withRetainedFollowed, type FollowedEntry } from './followed-networks.ts';
import type { ProfileDocument } from '@wayfarer/schemas';
import type { Inventory } from '../inventory/index.ts';
import {
  generateInterfaceName,
  linkFileFor,
  resolveBinding,
  type BindingRole,
  type Resolution,
} from './binding.ts';
import { checkInvariants, networkCidr, type Finding, type RuntimeFacts } from './invariants.ts';
import {
  emptyDesiredState,
  generatedHeader,
  orphanArtefacts,
  PATHS,
  type DesiredState,
  type DesiredUnit,
  type ManagedFile,
} from './desired-state.ts';
import { generateCoreConfigWithProvenance, tunnelDnsTag } from './generate/core-config.ts';
import { generateDhcp } from './generate/dhcp.ts';
import { generateFirewall } from './generate/firewall.ts';
import { generateHostapd, HOSTAPD_CONTROL_DIR } from './generate/hostapd.ts';
import { generateNetworkd, sysctlFor } from './generate/networkd.ts';
import { describeSsid, generateSupplicant } from './generate/supplicant.ts';
import { coreUnit, instanceOf, templateUnits } from './generate/units.ts';
import { DEVICE_TUN_ADDRESS, isStoredSecret } from '@wayfarer/schemas';
// Type-only, and circular with `emit.ts` on purpose: the emission shape is the planner's contract
// and the refusal shape is the catalogue's, so each names the other rather than a third module
// existing only to hold two interfaces apart.
import type { CarrierChoice, CoreCapabilities } from './catalogue/index.ts';
import type { TunnelRefusal } from './emit.ts';

export interface PlannerInput {
  profile: ProfileDocument;
  inventory: Inventory;
  facts: RuntimeFacts;
  /**
   * Per-tunnel emission from the catalogue: the core object and which array it joins, plus any files,
   * units and interfaces the entry contributes. The planner still never asks what protocol something
   * is — the entry already decided, and what arrives here is the result.
   */
  emissions: Map<string, TunnelEmission>;
  /**
   * Local ports this plan claims, from the emission. Handed to the collision check, which must see
   * every port rather than the ones it can recognise from the profile alone.
   */
  ports?: { port: number; owner: string; pointer: string }[];
  /**
   * Tunnels the catalogue would not plan, each already carrying its reason and a pointer.
   *
   * Passed as data rather than recomputed, because the entry that refused is the only thing that
   * knows why. A tunnel that is enabled, produces no emission and is not named here would be a
   * profile that appears to apply cleanly while doing less than it says.
   */
  refusals?: TunnelRefusal[];
  /**
   * Which carrier runs each tunnel that had a choice, by tunnel id.
   *
   * Becomes a note in the plan the owner reads **before** applying, rather than a line in a log
   * afterwards. He holds a link, not a preference, so the choice is made for him — and a choice made
   * for somebody without a sentence explaining it is the confident answer nobody can account for.
   */
  carriers?: Map<string, CarrierChoice>;
  /**
   * What the installed core was discovered to speak. Handed to the invariant checks, which ask each
   * catalogue entry whether this device can run it. Absent means nothing is known.
   */
  core?: CoreCapabilities;
  /** Where the management interface listens, so the ruleset can name the port. */
  managementPort: number;
  /** Ports time synchronisation uses. Configuration, never a constant at a call site. */
  timePorts: number[];
  /** Absolute path of the proxy core binary, from binary detection. */
  coreBinaryPath: string | null;
  /** Path of the script that captures a pushed resolver address. */
  upScriptPath: string;
  /**
   * Resolver addresses the up script captured from peers, by tunnel id — a **runtime fact**, like the
   * uplink networks, and for the same reason: the value is chosen by the peer at connection time and
   * cannot live in a profile.
   *
   * A peer may hand out a different resolver depending on which of its gateways answered. Measured on
   * the bench board, 2026-09-21, from one tunnel over one evening: `10.184.100.5`, `10.184.40.5` and
   * `10.184.48.5`, with only the current one reachable through the tunnel and the other two silent. A
   * profile that names one of them is right until the peer moves the device, and then internal names
   * stop resolving while everything else keeps working — which is exactly how a user found it rather
   * than us.
   *
   * Absent for a tunnel that has never connected, and that case is handled where it is read.
   */
  capturedResolvers?: Map<string, string>;
  /**
   * The followed networks the **running** fence recorded (`fence.json`), to be kept in the fence while
   * they are merely absent from the interfaces. Supplied by `core/pipeline.ts`, which also decides when
   * they are dropped instead; see `core/followed-networks.ts` for why a network leaves lazily.
   */
  retainedFollowed?: FollowedEntry[];
  /**
   * The operator CLI, as a unit can execute it.
   *
   * `/usr/local/bin/way` — the shell wrapper the installer writes — not the bundle it runs. Measured
   * on the bench board, 2026-09-20: a unit with `ExecStart=/opt/wayfarer/way.cjs` fails at boot with
   * `Failed at step EXEC ... Exec format error`, because a `.cjs` file is not something the kernel
   * knows how to execute. One definition, threaded from the configuration that already had it.
   */
  wayBinary: string;
  /**
   * Schema-level faults in tunnel configurations, found before anything is embedded.
   *
   * Computed by the caller, which holds the registry and the compiled validators, and passed in as
   * data so the planner stays pure. They become findings with a JSON Pointer into the profile — which
   * is the whole reason to run this pass here rather than letting the core reject the assembled file
   * later with a message about a file nobody wrote.
   */
  tunnelIssues?: { tunnelIndex: number; pointer: string; message: string }[];
}

export interface TunnelEmission {
  target: 'outbounds' | 'endpoints';
  object: Record<string, unknown>;
  files?: ManagedFile[];
  /** Unit names, already instantiated by the provider. */
  units?: { name: string; enabled: boolean; active: boolean; purpose: string }[];
  interfaces?: string[];
  dnsServer?: { address: string; viaInterface: string; domainSuffix?: string[] };
}

export interface Plan {
  desired: DesiredState;
  findings: Finding[];
  /** Resolution per role key, so the interface can report an unbound role as a state. */
  bindings: Map<string, Resolution>;
  /** True when no finding is an error. A plan with errors is still returned, so it can be shown. */
  usable: boolean;
}

export function plan(input: PlannerInput): Plan {
  const { profile, inventory } = input;
  const desired = emptyDesiredState();

  /* ── resolve hardware ─────────────────────────────────────────────────────────────────── */

  const bindings = new Map<string, Resolution>();
  const uplinkInterfaces = new Map<string, string>();

  /**
   * Interfaces whose planned name does not exist yet, because this plan renames them.
   *
   * A rename is `boot` class: systemd applies a `.link` file when the device appears, so the new name
   * exists only after a reboot. Any unit instanced on that name therefore **cannot start in this
   * apply** — the device unit it is bound to does not exist.
   *
   * Measured on the bench board, 2026-09-20: pinning the wireless uplink planned both
   * `rename wlan1 to wfwan0` and `start wf-supplicant@wfwan0.service`, and the apply spent ninety
   * seconds failing to start a unit bound to a device that will not exist until the next boot, then
   * reverted. The plan was not wrong to want both; it was wrong to want them at the same moment.
   */
  const awaitingRename = new Set<string>();

  let lanInterface: string | null = null;

  /**
   * Addresses already pinned to a name by a `.link` file.
   *
   * A radio that hosts an access point and a client at once resolves **both** roles to the same
   * radio, and therefore to the same address. Emitting a `.link` file for each would put two files
   * matching one address with different names into `/etc/systemd/network`: systemd applies the first
   * in lexical order and the other silently never takes effect, so the device reports a pending
   * rename for ever and one of the two names is a fiction.
   *
   * So the first role to claim an address pins it, and the second is reported as a note. The second
   * interface on such a radio is created by the access-point daemon on the same physical device, and
   * an address-matched rule is not the way to name it.
   */
  const pinnedAddresses = new Set<string>();

  const pin = (role: BindingRole, resolution: Extract<Resolution, { state: 'bound' }>, purpose: string): void => {
    // A role that did not ask to be pinned writes no link file and renames nothing. `linkFileFor`
    // enforces the same thing; the early return here keeps the shared-address note below from firing
    // for roles that were never going to write a file.
    if (!resolution.pinned) return;
    if (resolution.mac === null) return;
    const address = resolution.mac.toLowerCase();
    if (pinnedAddresses.has(address)) {
      desired.notes.push(
        `${resolution.name} shares a radio with an interface that is already pinned to ${address}, so ` +
          'its name is not pinned by a link file. Two files matching one address would conflict, and ' +
          'systemd would apply only the first.',
      );
      return;
    }
    const link = linkFileFor(role, resolution);
    if (link === null) return;
    pinnedAddresses.add(address);
    // Read by systemd-networkd at the moment the link appears, not by any unit of ours — which is
    // also why a rename only takes effect at the next boot.
    desired.networkFiles.push({ ...link, purpose, consumedBy: { kind: 'external', by: 'systemd-networkd' } });
  };

  if (profile.accessPoint !== null) {
    const role: BindingRole = { kind: 'access-point' };
    const resolution = resolveBinding({
      binding: profile.accessPoint.bind,
      role,
      inventory,
      wireless: true,
      ...(profile.accessPoint.pinName === true ? { pinName: true } : {}),
    });
    bindings.set('access-point', resolution);
    if (resolution.state === 'bound') {
      lanInterface = resolution.name;
      if (resolution.pinned && resolution.mac === null) {
        desired.notes.push(
          `The access-point interface cannot be pinned to a stable name: ${resolution.phy ?? 'the radio'} ` +
            'reports no usable address. The name may differ after a reboot, and a unit that names it ' +
            'would then depend on a device that does not exist.',
        );
      } else if (!resolution.pinned && resolution.currentName === null) {
        // The generated name was used because there was no other, and no link file was written. The
        // distinction matters: a name with nothing creating the interface is a name nothing answers to.
        desired.notes.push(
          `${resolution.phy ?? 'The access-point radio'} has no interface yet, so ${resolution.name} is a ` +
            'name this plan invented rather than one the kernel reports. Nothing here creates a wireless ' +
            'interface on a radio that has none, so the access point will not start until one exists.',
        );
      } else {
        if (resolution.currentName !== null && resolution.currentName !== resolution.name) {
          awaitingRename.add(resolution.name);
        }
        pin(role, resolution, 'pins the access-point interface name');
      }
    }
  } else {
    desired.notes.push(
      'This profile hosts no access point. That is a valid state — a device with no radio, or one ' +
        'reached over Ethernet only — but nothing will serve the local network.',
    );
  }

  profile.uplinks.forEach((uplink, index) => {
    if (uplink.enabled === false) return;
    const role: BindingRole = { kind: 'uplink', id: uplink.id, index };
    const resolution = resolveBinding({
      binding: uplink.bind,
      role,
      inventory,
      wireless: uplink.kind === 'wifi-sta',
      ...(uplink.pinName === true ? { pinName: true } : {}),
    });
    bindings.set(`uplink:${uplink.id}`, resolution);
    if (resolution.state === 'bound') {
      uplinkInterfaces.set(uplink.id, resolution.name);
      if (resolution.currentName !== null && resolution.currentName !== resolution.name) {
        awaitingRename.add(resolution.name);
      }
      pin(role, resolution, `pins the interface for uplink "${uplink.id}"`);
    }
  });

  if (profile.uplinks.length === 0) {
    desired.notes.push(
      'No uplink is configured. This is the default and a valid state: the device serves its local ' +
        'network and reaches nothing beyond it until an uplink is added.',
    );
  }

  /* ── invariants, before anything is generated ─────────────────────────────────────────── */

  const findings = checkInvariants({
    profile,
    inventory,
    bindings,
    facts: input.facts,
    ...(input.ports ? { ports: input.ports } : {}),
    ...(input.core ? { core: input.core } : {}),
  });

  for (const issue of input.tunnelIssues ?? []) {
    const tunnel = profile.tunnels[issue.tunnelIndex];
    findings.push({
      severity: 'error',
      code: 'tunnel_config_invalid',
      message: `"${tunnel?.name ?? `tunnel ${issue.tunnelIndex}`}": ${issue.message}`,
      pointer: issue.pointer,
      // The hint said "use the raw editor", which E4 deleted along with the generic path. A hint
      // naming a screen that does not exist sends somebody looking for it and then doubting the
      // rest of the message. The pointer already names the field; what this adds is where to go.
      hint:
        'The installed core rejects this field. Correct it on this tunnel’s screen — the pointer ' +
        'names the field — or export the profile with GET /api/profiles/{id}/export to see the ' +
        'stored document as it is.',
    });
  }

  /* ── generate ─────────────────────────────────────────────────────────────────────────── */

  // Generation continues even with errors, because the plan review shows the diff alongside the
  // findings and an operator correcting a configuration wants to see both. Nothing is applied while
  // an error stands; that gate is the reconciler's, not this function's.

  /**
   * The wireless uplinks: one supplicant configuration and one instance each.
   *
   * Emitted before the networkd files only because the reader meets the radio before its addressing.
   * A wireless uplink that is configured but whose interface did not resolve emits nothing at all —
   * the binding failure is already a finding, and a configuration file naming an interface that does
   * not exist is an orphan by the rule below.
   */
  for (const uplink of profile.uplinks) {
    if (uplink.kind !== 'wifi-sta' || uplink.enabled === false) continue;
    const interfaceName = uplinkInterfaces.get(uplink.id);
    if (interfaceName === undefined) continue;
    const psk = uplink.config.psk;
    /*
     * A passphrase WPA cannot use is already an error finding, and a plan carrying an error is never
     * applied. Emitting nothing for this uplink is what keeps the planner *pure*: it returns a plan
     * plus findings, and a generator that throws turns a correctable mistake in a form field into an
     * exception with a stack trace where a sentence naming the field belongs.
     */
    if (!wpaPassphraseUsable(psk)) continue;
    desired.files.push({
      path: `${PATHS.supplicantDir}/${interfaceName}.conf`,
      content: generateSupplicant({
        uplink,
        interfaceName,
        profileName: profile.meta.name,
        // An absent or null key is an open network. That is a real configuration, not a mistake, and
        // the generator says so in the file rather than leaving `key_mgmt` to a default.
        passphrase: psk === undefined || psk === null ? null : secretValue(psk),
      }),
      // The network key is derived into this file, so it is readable by root only.
      mode: 0o600,
      credentials: true,
      purpose: `the wireless uplink "${uplink.id}" on ${interfaceName}`,
      consumedBy: { kind: 'unit', unit: instanceOf('wf-supplicant@.service', interfaceName) },
    });
    const startsAfterReboot = awaitingRename.has(interfaceName);
    desired.units.push({
      name: instanceOf('wf-supplicant@.service', interfaceName),
      enabled: true,
      // Enabled but not started when the interface does not answer to this name yet. Enabling is what
      // makes the reboot finish the job; starting now would only fail.
      active: !startsAfterReboot,
      purpose: `associates ${interfaceName} with ${describeSsid(uplink.config.ssid)}`,
    });
    if (startsAfterReboot) {
      desired.notes.push(
        `The wireless uplink "${uplink.id}" is being renamed to ${interfaceName}, which takes effect at ` +
          'the next reboot. Its client is enabled now and starts then; until then the interface keeps ' +
          'its current name and its current configuration.',
      );
    }
    desired.interfaces.push(interfaceName);
  }

  desired.networkFiles.push(...generateNetworkd({ profile, lanInterface, uplinkInterfaces }));
  desired.sysctl.push(...sysctlFor(profile, lanInterface));

  /**
   * The same settings, written where the kernel will read them again at the next boot.
   *
   * Applying a sysctl changes the running kernel and nothing else. Measured on the bench board,
   * 2026-09-20: after a reboot the plan wanted `net.ipv4.ip_forward` set back to 1 — because the
   * reboot had reset it — which on an unattended device means clients on the access point lose their
   * route to the internet at every power cycle and nothing says why.
   *
   * The drop-in is the persistence; the live `sysctl` write above is what makes it take effect now.
   * Both, because either alone is a device that is right only before or only after a reboot.
   */
  if (desired.sysctl.length > 0) {
    desired.files.push({
      path: PATHS.sysctlDropIn,
      mode: 0o644,
      purpose: 'makes the kernel settings survive a reboot',
      // Read by systemd-sysctl at boot, not by any unit of ours.
      consumedBy: { kind: 'external', by: 'systemd-sysctl' },
      content:
        generatedHeader('#', profile.meta.name) +
        '#\n' +
        '# These are applied live on every apply as well. This file is what makes them survive a\n' +
        '# reboot, which the running kernel does not.\n' +
        '\n' +
        desired.sysctl.map((setting) => `# ${setting.reason}\n${setting.key} = ${setting.value}\n`).join('\n'),
    });
  }

  /**
   * The interfaces whose addressing this plan owns, and the foreign claims it will clear.
   *
   * `managedInterfaces` is named rather than "everything", because `networkctl reconfigure` across a
   * whole device would touch interfaces this profile has nothing to do with — the same boundary the
   * unit-ownership rule draws, applied to links.
   */
  desired.managedInterfaces = [
    // The access-point interface gets a static address and its carrier appears only when hostapd
    // starts, which is later in the apply order. Waiting for a carrier here would wait the full
    // timeout on every apply and then report a healthy interface as unsettled.
    ...(lanInterface === null ? [] : [{ name: lanInterface, expect: 'address' as const }]),
    ...[...uplinkInterfaces.values()]
      .filter((name) => name !== lanInterface)
      .map((name) => ({ name, expect: 'carrier-and-address' as const })),
  ];

  /**
   * Which claims this apply will clear.
   *
   * Only for roles that asked. A claim on an interface nobody opted in for is left alone and becomes
   * an error from the invariant check instead — writing a second configuration for an interface
   * another manager owns is the lockout shape, and doing it without being told to would be this
   * project taking a decision it has no business taking.
   */
  const takingOver = new Set<string>();
  const wantsTakeover: { role: string; wanted: boolean }[] = [
    { role: 'access-point', wanted: profile.accessPoint?.takeOverInterface === true },
    ...profile.uplinks.map((uplink) => ({ role: `uplink:${uplink.id}`, wanted: uplink.takeOverInterface === true })),
  ];
  for (const entry of wantsTakeover) {
    if (!entry.wanted) continue;
    const resolution = bindings.get(entry.role);
    if (resolution?.state !== 'bound') continue;
    // Both names: a claim is written against whichever name the other manager knows, and for a role
    // that is also being renamed those are two different strings.
    takingOver.add(resolution.name);
    if (resolution.currentName !== null) takingOver.add(resolution.currentName);
  }

  for (const claim of input.facts.interfaceClaims) {
    if (!takingOver.has(claim.interface)) continue;
    // A claim file can name several interfaces, so the same file can appear more than once. It is
    // moved once, and a second move of a file that is already gone would be an error rather than the
    // no-op it should be.
    if (desired.takeover.some((entry) => entry.path === claim.file)) continue;
    desired.takeover.push({ path: claim.file, by: claim.by, interfaceName: claim.interface });
  }

  const tunnelInterfaceNames: string[] = [];
  const tunnelDns = new Map<string, { address: string; viaInterface: string; domainSuffix: string[] }>();
  for (const tunnel of profile.tunnels) {
    if (!tunnel.enabled) continue;
    const emission = input.emissions.get(tunnel.id);
    if (!emission) {
      /**
       * The catalogue refused, and the refusal is repeated verbatim rather than summarised.
       *
       * It already names the tunnel, the protocol and the field, and it already says that nothing has
       * stopped — a device's units are independent of this daemon, so a profile that cannot be planned
       * is a configuration that cannot be managed and not a network that has failed. Rewording it here
       * would produce a second sentence meaning the same thing, which is two defects to report.
       */
      const refusal = input.refusals?.find((entry) => entry.tunnelId === tunnel.id);
      findings.push({
        severity: 'error',
        code: 'tunnel_refused',
        message: refusal?.reason ?? `Tunnel "${tunnel.name}" was not planned, and nothing said why.`,
        pointer: refusal?.pointer ?? `/tunnels/${profile.tunnels.indexOf(tunnel)}/protocol`,
        hint:
          refusal?.requires && refusal.requires.length > 0
            ? `Install on this device: ${refusal.requires
                .map((entry) => `${entry.binary} (for ${entry.neededFor})`)
                .join(', ')}. This daemon never downloads executables.`
            : 'Correct the tunnel, or disable it. The tunnel is kept in the profile rather than ' +
              'removed, so nothing of what was configured is lost while it is being fixed.',
      });
      continue;
    }

    /**
     * The carrier, stated in the plan the owner reads before applying.
     *
     * A note rather than a finding: nothing is wrong. What would be wrong is running a second process
     * on his device, or not running one, without the sentence that says which and why.
     */
    const carrier = input.carriers?.get(tunnel.id);
    if (carrier) desired.notes.push(`"${tunnel.name}": ${carrier.reason}`);
    if (emission.files) desired.files.push(...emission.files);
    if (emission.units) desired.units.push(...emission.units);
    /*
     * Which units this one tunnel is made of, kept apart from `desired.units` — which also collects
     * the access point, the firewall and the core, and from which the grouping cannot be recovered.
     *
     * The alternative was to rebuild the names from the tunnel's protocol at the point of use, which
     * is the second copy of a naming rule this file already refuses to make for the interface names
     * a few lines below.
     *
     * A planned tunnel that emits **no** units is still recorded, with an empty list. Leaving it out
     * would drop it from the status view entirely, and a tunnel the operator configured that is
     * simply absent from the report is the silence this field exists to break; an empty list reaches
     * the consumer as `unknown`, which is the true answer.
     */
    desired.tunnelUnits.push({
      id: tunnel.id,
      units: (emission.units ?? []).map((unit) => unit.name),
      interfaces: [...(emission.interfaces ?? [])],
    });
    if (emission.interfaces) {
      desired.interfaces.push(...emission.interfaces);
      // Kept apart from `desired.interfaces`, which also collects the access point and the uplinks.
      // A consumer asking "is this interface a tunnel of ours" needs the tunnels alone.
      tunnelInterfaceNames.push(...emission.interfaces);
    }

    const dns = emission.dnsServer ?? tunnelDnsFromProfile(tunnel, input.capturedResolvers, findings);
    if (dns) {
      tunnelDns.set(tunnel.id, {
        address: dns.address,
        viaInterface: dns.viaInterface,
        domainSuffix: dns.domainSuffix ?? [],
      });
    }
  }

  // The interface reading the fence is built from, with the running fence's followed networks retained
  // where they are only absent. One value for all three consumers below — the fence, the split into
  // followed and defended, and the record — so they cannot describe different readings.
  const networkReading = withRetainedFollowed(input.facts.uplinkNetworks, tunnelInterfaceNames, input.retainedFollowed);

  const { config: coreConfig, observed: observedInCore } = generateCoreConfigWithProvenance({
    profile,
    interfaces: { accessPoint: lanInterface, uplinks: uplinkInterfaces },
    emitted: new Map(
      [...input.emissions.entries()].map(([id, emission]) => [id, { target: emission.target, object: emission.object }]),
    ),
    tunnelDns,
    /**
     * The networks the uplinks are on, straight from the runtime facts.
     *
     * The planner cannot compute this — it is a reading of the device, which is exactly why its absence
     * was invisible to every schema, invariant and golden file: nothing in the profile was missing.
     */
    uplinkNetworks: networkReading.map((entry) => entry.cidr),
  });

  if (input.coreBinaryPath !== null) desired.files.push({
    path: PATHS.coreConfig,
    consumedBy: { kind: 'unit', unit: 'wf-core.service' },
    // Two-space indentation and a trailing newline: this file is read by a person during an incident
    // at least as often as by the core, and a single-line 40 KB document is not readable.
    content: `${JSON.stringify(coreConfig, null, 2)}\n`,
    // 0600: the resolved configuration contains real credentials in clear, by necessity. It is never
    // logged and never returned whole by an API route — the plan review renders the profile
    // document, where secrets are still wrapped.
    //
    // **Corrected 2026-09-22.** This said "never rendered in a diff", and the drift check had been
    // rendering it pointer by pointer with both values since G1 landed, which published a proxy's
    // password and a VLESS account's uuid to `GET /api/drift`, the Status screen and the persisted
    // event ring. `core/drift.ts` now withholds both values at a credential-bearing pointer. A
    // comment asserting a property nothing checks is how the property gets lost.
    mode: 0o600,
    purpose: 'the proxy core configuration',
    // Carries the networks this device is currently on, in its exclusion list and its direct rules,
    // so it goes stale the moment the device is moved to another network.
    environmentDependent: true,
    observed: [...observedInCore, ...observedResolvers(coreConfig, profile, input.capturedResolvers)],
  });

  // The resolved names, recorded on the desired state so the listener binds what resolved rather than what
  // the profile expected. The same two values the firewall rules are generated from, so the two layers
  // enforcing this decision cannot disagree about which interfaces they mean.
  desired.managementSurfaces = {
    accessPoint: lanInterface,
    uplinks: [...uplinkInterfaces.values()],
    tunnels: tunnelInterfaceNames,
  };

  /**
   * Which networks this device defends, and which it merely follows.
   *
   * Split by **which interface the address was read from**, not by a name pattern: `wfvpn` is a
   * convention, and a second copy of a convention agrees with the first exactly until one of them
   * changes. The tunnel interface names come from this planner's own emission, a few lines above.
   *
   * The defended list is built from the same three inputs the exclusion list is built from — the
   * served LAN, the transfer network, and the networks of everything that is not one of our tunnels
   * — so an address can reach the exclusion list without reaching one of these two lists only if a
   * fourth source is added. A test asserts that has not happened. The differ is the only consumer.
   */
  const tunnelInterfaces = new Set(tunnelInterfaceNames);
  const followedNetworks = new Set<string>();
  const defendedNetworks = new Set<string>();
  for (const entry of networkReading) {
    const cidr = networkCidr(entry.cidr) ?? entry.cidr;
    (tunnelInterfaces.has(entry.interface) ? followedNetworks : defendedNetworks).add(cidr);
  }
  for (const ours of [networkCidr(profile.network.cidr), networkCidr(DEVICE_TUN_ADDRESS)]) {
    if (ours !== null) defendedNetworks.add(ours);
  }
  /**
   * The served LAN in **host** form as well as network form, because the generated document uses
   * both and they are not the same string.
   *
   * Found by the coverage test below this comment's consumer, on its first run: the exclusion list
   * normalises `10.44.0.1/24` to `10.44.0.0/24`, and the `protect-own-networks` rule emits the raw
   * `10.44.0.1/24`. Listing both keeps the classification total. **The underlying inconsistency is a
   * separate defect and is deliberately not fixed here** — normalising that rule changes what the
   * core is given, which is a network-class change and not part of a classification fix. It is
   * recorded rather than absorbed.
   */
  defendedNetworks.add(profile.network.cidr);

  /*
   * The fence's own record of what in it is followed, written beside it and in the same change.
   *
   * Whether a network may **leave** the fence without a window cannot be decided from today's reading:
   * the reading is exactly what an uplink flap empties. Measured by the acceptance tester, 2026-09-23,
   * on the bench board's own configuration: with the uplink momentarily unaddressed, its network was
   * on neither list and dropping it from the fence was classed `service`. So the permission to drop a
   * network comes from what the running fence recorded when it was written, not from what is on the
   * interfaces now.
   */
  const followedRecord = networkReading
    .filter((entry) => tunnelInterfaces.has(entry.interface))
    .map((entry) => ({ network: networkCidr(entry.cidr) ?? entry.cidr, interface: entry.interface }))
    .sort((left, right) => left.network.localeCompare(right.network) || left.interface.localeCompare(right.interface));
  desired.files.push({
    path: PATHS.coreFence,
    content: `${JSON.stringify({ followed: followedRecord }, null, 2)}\n`,
    mode: 0o600,
    purpose: 'which networks in the core exclusion list are followed tunnel networks',
    consumedBy: { kind: 'reader', by: 'the differ, deciding whether a network may leave the fence without a window' },
    // Written from the same reading as the fence, so it goes stale with it and is re-derived with it.
    environmentDependent: true,
  });

  desired.reachabilityNetworks = {
    followed: [...followedNetworks],
    // A network read from a tunnel interface is followed, never defended, even if something else
    // also reports it: the softening is refused when a list is ambiguous, so overlap must not
    // silently land on the defended side and re-close the gate.
    defended: [...defendedNetworks].filter((cidr) => !followedNetworks.has(cidr)),
  };

  const ruleset = generateFirewall({
    profile,
    lanInterface,
    wanInterfaces: [...uplinkInterfaces.values()],
    managementPort: input.managementPort,
    timePorts: input.timePorts,
  });
  desired.files.push({
    path: PATHS.firewall,
    content: ruleset,
    mode: 0o600,
    purpose: 'the firewall ruleset',
    // The unit that actually runs `nft -f` on it. Naming it here is what stops this file becoming an
    // orphan again: the check below refuses a plan whose ruleset names a unit it does not generate.
    consumedBy: { kind: 'unit', unit: 'wf-firewall.service' },
    // Carries the networks this device is currently on, so it goes stale when the device moves.
    environmentDependent: true,
  });

  if (profile.accessPoint !== null && lanInterface !== null) {
    const apResolution = bindings.get('access-point');
    // Narrowed once into a local: a resolution is a union, and reading `.phy` off the map entry again
    // inside the closure below loses the narrowing.
    const apPhy = apResolution?.state === 'bound' ? apResolution.phy : null;
    const radio = apPhy === null ? undefined : inventory.radios.find((entry) => entry.phy === apPhy);

    if (radio) {
      const together = radio.derived.accessPointAndClientTogether.value;
      const sharesRadio = profile.uplinks.some((uplink) => {
        if (uplink.kind !== 'wifi-sta') return false;
        const resolution = bindings.get(`uplink:${uplink.id}`);
        return resolution?.state === 'bound' && resolution.phy === apPhy;
      });

      desired.files.push({
        path: `${PATHS.hostapdDir}/${lanInterface}.conf`,
        content: generateHostapd({
          profile,
          interfaceName: lanInterface,
          radio,
          passphrase: secretValue(profile.accessPoint.passphrase),
          channelFollowsUplink: sharesRadio && together.supported && together.sameChannelOnly,
        }),
        // The passphrase is in this file, so it is readable by root only.
        mode: 0o600,
        credentials: true,
        purpose: `the access point on ${lanInterface}`,
        consumedBy: { kind: 'unit', unit: instanceOf('wf-hostapd@.service', lanInterface) },
      });
      desired.units.push({
        name: instanceOf('wf-hostapd@.service', lanInterface),
        enabled: true,
        active: true,
        purpose: `hosts the access point on ${lanInterface}`,
      });
      desired.interfaces.push(lanInterface);
      desired.notes.push(
        `Access-point control uses the socket at ${HOSTAPD_CONTROL_DIR}. Running hostapd_cli by hand ` +
          `needs \`-p ${HOSTAPD_CONTROL_DIR}\`, or it reports a working access point as absent.`,
      );
      // Said before it happens rather than discovered afterwards. Measured on the bench board: a
      // request for channel 36 came up on 40, because hostapd runs the HT40 co-existence scan the
      // standard requires and swaps primary and secondary to put the secondary where it heard no
      // beacons. The 80 MHz block is unchanged — only the primary 20 MHz channel within it moves — and
      // refusing this would mean an access point that fails to start for behaving correctly.
      if (profile.accessPoint.radio.width >= 40) {
        desired.notes.push(
          `The access point requests channel ${profile.accessPoint.radio.channel}. hostapd may come up on ` +
            'a different primary channel within the same block: it scans for neighbours first and swaps ' +
            'the primary and secondary channels to put the secondary where it heard none. The status ' +
            'view reports the channel actually in use, which is the one to trust.',
        );
      }
    }

    if (profile.network.dhcp.enabled) {
      desired.files.push({
        path: `${PATHS.dhcpDir}/${lanInterface}.conf`,
        content: generateDhcp({ profile, interfaceName: lanInterface }),
        mode: 0o644,
        purpose: `hands out addresses on ${lanInterface}`,
        consumedBy: { kind: 'unit', unit: instanceOf('wf-dhcp@.service', lanInterface) },
      });
      desired.units.push({
        name: instanceOf('wf-dhcp@.service', lanInterface),
        enabled: true,
        active: true,
        purpose: `the address service on ${lanInterface}`,
      });
    }
  }

  // `timePorts` reaches the firewall unit as well as the ruleset: the ruleset marks those ports and the
  // unit installs the policy rule that keeps them off the tunnel. Both halves must name the same ports,
  // so they come from one value rather than two lists that agree until somebody edits one.
  desired.units.push(
    ...templateUnits({ upScript: input.upScriptPath, wayPath: input.wayBinary, timePorts: input.timePorts }),
  );

  /**
   * The core runs whenever it is installed, not only when there are tunnels.
   *
   * Corrected here after the orphan-artefact check refused a plan that had been passing: the core
   * configuration was generated unconditionally while the unit that reads it was generated only when a
   * tunnel was enabled, so a profile with an access point and no tunnels wrote a configuration nothing
   * would ever load.
   *
   * The fix is to start the core rather than to stop writing the file, because the file was right and
   * the gate was wrong. **The core is this device's resolver**, not only its tunnel engine: the
   * generated address service runs with `port=0` and hands clients DHCP option 6 pointing at the
   * device itself, and the thing that answers on that address is the core. Gating it on tunnels meant
   * a tunnel-free profile produced a working access point whose clients could not resolve a name —
   * which looks like a broken internet connection and is a missing daemon.
   *
   * With no core installed the configuration is not generated either, so the two stay in step. A
   * profile that needs one then says so through the requirement check below rather than through a file
   * nobody reads.
   */
  if (input.coreBinaryPath !== null) {
    desired.units.push(coreUnit({ binaryPath: input.coreBinaryPath }));
    desired.checks.push({ kind: 'core-check', configPath: PATHS.coreConfig });
  } else if (profile.tunnels.some((tunnel) => tunnel.enabled)) {
    findings.push({
      severity: 'error',
      code: 'binary_missing',
      message: 'This profile has tunnels, and no proxy core is installed.',
      pointer: '/tunnels',
      hint: 'Install the core. This daemon never downloads executables.',
    });
  } else if (profile.accessPoint !== null && profile.network.dhcp.enabled) {
    // Not an error: a device with no core still routes and still hands out addresses. It is a warning
    // because the consequence is specific and invisible from the outside — clients associate, get a
    // lease, and then resolve nothing.
    findings.push({
      severity: 'warning',
      code: 'no_resolver',
      message:
        'No proxy core is installed, and this profile serves a local network. Clients will get an ' +
        'address and a resolver pointing at this device, and nothing here will answer it.',
      pointer: '/network/dhcp/enabled',
      hint: 'Install the proxy core. It is this device’s resolver as well as its tunnel engine.',
    });
  }

  /**
   * Every directory this plan needs to write in, named by the plan rather than assumed by the reconciler.
   *
   * Derived from what was actually emitted, so a new generator writing somewhere new is covered without
   * anybody remembering to add it — which is the whole point, since the failure this prevents was exactly
   * somebody not remembering.
   */
  desired.checks.push({
    kind: 'paths-writable',
    directories: [
      ...new Map(
        [
          ...[...desired.files, ...desired.networkFiles].map((file) => ({
            path: file.path.replace(/\/[^/]+$/, ''),
            why: file.purpose,
          })),
          // A takeover moves a file *within* its own directory, so that directory has to be writable too —
          // and it belongs to another program, which is precisely why nobody thought to check it.
          ...desired.takeover.map((claim) => ({
            path: claim.path.replace(/\/[^/]+$/, ''),
            why: `moving ${claim.by}'s configuration aside to take over ${claim.interfaceName}`,
          })),
        ].map((entry) => [entry.path, entry]),
      ).values(),
    ],
  });

  desired.checks.push({ kind: 'nft-check', ruleset });
  // Before touching a unit, confirm every unit this plan will act on is one we generated. The list is
  // checked rather than assumed, because the cost of being wrong is stopping somebody else's service.
  desired.checks.push({ kind: 'unit-not-foreign', units: desired.units.map((unit) => unit.name) });

  desired.files.push(readme(profile));

  /**
   * Unit files are managed files too.
   *
   * They were not, and the bug was invisible to every test that mocked systemd: `install` did a
   * daemon-reload for a unit file that had never been written, and the `enable` that followed failed
   * with "Unit wf-firewall-ready.target does not exist". Found by running an apply on a real board,
   * which is the argument for having done that.
   *
   * Routing them through the ordinary file path also buys idempotency for free — the differ compares
   * the content, so re-applying does not rewrite a unit file that already matches, and a unit whose
   * definition changed is the thing that makes the reload necessary.
   */
  for (const unit of desired.units) {
    if (unit.content === undefined) continue;
    desired.files.push({
      path: `${PATHS.unitDir}/${unit.name}`,
      content: unit.content,
      mode: 0o644,
      purpose: `the unit definition for ${unit.name}`,
      // systemd reads it, not one of our units. Saying so keeps the check honest rather than making
      // every unit file appear to depend on itself.
      consumedBy: { kind: 'external', by: 'systemd' },
    });
  }

  /**
   * No artefact may be written that nothing reads.
   *
   * Last: it inspects the finished state, so it sees every file every generator contributed. This is
   * the structural answer to a fault that was invisible to everything else — the firewall ruleset was
   * generated, written, diffed and shown in the plan review while **no unit ever loaded it**, so a
   * device that had been power-cycled had none of its rules and every file on disk said otherwise.
   *
   * An error rather than a warning. A file documenting an intention the system does not have is worse
   * than a missing file, because the plan review makes it convincing.
   */
  for (const orphan of orphanArtefacts(desired)) {
    findings.push({
      severity: 'error',
      code: 'artefact_not_consumed',
      message: `${orphan.path} would be written and never read: ${orphan.reason}`,
      pointer: '',
      hint:
        'This is a bug in a generator, not a configuration problem. Either the unit that reads this ' +
        'file is missing from the plan, or the file should not be generated at all.',
      detail: { path: orphan.path },
    });
  }

  return {
    desired,
    findings,
    bindings,
    usable: !findings.some((finding) => finding.severity === 'error'),
  };
}

/**
 * A file in the configuration directory saying what owns it.
 *
 * Not decoration. Somebody will find `/etc/wayfarer` on a device months from now, with no memory of
 * how it got there, and the useful thing to find next to it is a sentence about what may be edited.
 */
function readme(profile: ProfileDocument): ManagedFile {
  return {
    path: `${PATHS.coreConfig.replace(/\/core\/config\.json$/, '')}/README`,
    mode: 0o644,
    purpose: 'says what owns this directory',
    // For a person, and the only artefact here that is. It is not configuration and nothing loads it.
    consumedBy: { kind: 'reader', by: 'whoever finds this directory on a device' },
    content:
      generatedHeader('#', profile.meta.name) +
      '#\n' +
      '# Everything under this directory is generated from the active profile and is replaced on every\n' +
      '# apply. Editing a file here has no lasting effect: change the profile instead.\n' +
      '#\n' +
      '# Units generated alongside these files are named wf-*, and are owned exclusively. Units this\n' +
      '# device did not generate are never started, stopped or removed by it.\n',
  };
}

/**
 * The resolver pointers in the core configuration whose value is the peer's to choose.
 *
 * Marked whether or not a capture was found: a dynamic resolver taken from the profile is the
 * profile's *starting point*, a guess until the tunnel connects, and a drift finding about it must say
 * it is about a reading rather than a setting.
 */
function observedResolvers(
  config: Record<string, unknown>,
  profile: ProfileDocument,
  captured: Map<string, string> | undefined,
): { pointer: string; from: string; unordered: boolean }[] {
  const servers = ((config['dns'] as { servers?: unknown } | undefined)?.servers ?? []) as { tag?: unknown }[];
  return profile.tunnels
    .filter((tunnel) => tunnel.enabled && tunnel.dns?.dynamic === true)
    .flatMap((tunnel) => {
      const index = servers.findIndex((server) => server.tag === tunnelDnsTag(tunnel.id));
      if (index < 0) return [];
      const live = captured?.get(tunnel.id);
      return [
        {
          pointer: `/dns/servers/${String(index)}/server`,
          from:
            live !== undefined && live !== ''
              ? `the resolver "${tunnel.name}"'s peer pushed, as the tunnel up-script captured it`
              : `the profile's starting value for "${tunnel.name}", because no resolver had been captured from its peer`,
          unordered: false,
        },
      ];
    });
}

/**
 * The resolver to use for a tunnel, preferring what the peer actually pushed.
 *
 * `dns.dynamic` means the address is the peer's to choose. When the up script has captured one, that is
 * the truth and the profile's value is a stale guess; when it has not — the tunnel has never come up on
 * this boot — the profile's value is used.
 *
 * **Falling back to the profile rather than refusing is deliberate, and it is the smaller loss.** A
 * missing capture is the normal state before a tunnel first connects, and refusing would mean no core
 * configuration at all: no access point routing, no other tunnel, nothing. Using a possibly-stale
 * resolver costs one tunnel's name resolution until it connects and the capture arrives. One tunnel's
 * internal names beat the whole device.
 *
 * The finding is raised either way, because the operator is entitled to know which of the two they have.
 */
export function tunnelDnsFromProfile(
  tunnel: ProfileDocument['tunnels'][number],
  captured: Map<string, string> | undefined,
  findings: Finding[],
): { address: string; viaInterface: string; domainSuffix?: string[] } | null {
  if (!tunnel.dns) return null;
  let address = tunnel.dns.server;

  if (tunnel.dns.dynamic === true) {
    const live = captured?.get(tunnel.id);
    if (live !== undefined && live !== '') {
      if (live !== tunnel.dns.server) {
        findings.push({
          severity: 'warning',
          code: 'dynamic_resolver_differs',
          message:
            `"${tunnel.name}" is using the resolver its peer pushed, ${live}, rather than the ${tunnel.dns.server} ` +
            'written in the profile. The peer chooses this address per connection, so the profile value is a ' +
            'starting point rather than a setting.',
          pointer: `/tunnels/${tunnel.id}/dns/server`,
          hint: 'Nothing to change. This is shown so the address in the profile is not mistaken for the one in use.',
          detail: { captured: live, profile: tunnel.dns.server },
        });
      }
      address = live;
    } else {
      findings.push({
        severity: 'warning',
        code: 'dynamic_resolver_uncaptured',
        message:
          `"${tunnel.name}" takes its resolver from its peer, and none has been captured yet — so the ` +
          `profile's ${tunnel.dns.server} is being used. If that peer hands out a different address on this ` +
          'connection, names behind this tunnel will not resolve while everything else keeps working.',
        pointer: `/tunnels/${tunnel.id}/dns/server`,
        hint:
          'Expected before the tunnel first connects. If it persists after it is up, the capture is not ' +
          'reaching this device and internal names are the thing that will break.',
        detail: { profile: tunnel.dns.server },
      });
    }
  }

  return {
    address,
    viaInterface: tunnel.id,
    ...(tunnel.dns.domainSuffix ? { domainSuffix: tunnel.dns.domainSuffix } : {}),
  };
}

/**
 * Unwraps a stored secret for a generated file.
 *
 * The generated artefact necessarily contains the real value: hostapd cannot be handed a redaction
 * marker. This is the one place the wrapper comes off, and everything downstream of it — the file's
 * mode, the rule that generated artefacts are never logged or returned, the diff rendering the
 * profile rather than the output — exists because of that.
 *
 * A redaction marker reaching here means an imported profile was applied with a gap still in it. That
 * is a validation failure upstream, and it throws rather than writing an empty passphrase: an access
 * point with an empty passphrase is an open network.
 */
/**
 * Whether a wireless passphrase is one WPA can turn into a key.
 *
 * `null`/absent is an open network, which is usable. Anything present is checked against the
 * standard's bounds; the matching finding, with the field pointer, comes from the invariants.
 */
function wpaPassphraseUsable(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  let text: string | null = null;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'object' && '$secret' in value) {
    const inner = (value as { $secret: unknown }).$secret;
    text = Array.isArray(inner) ? inner.join('\n') : typeof inner === 'string' ? inner : null;
  }
  // A secret that is missing or still redacted is a different fault, reported elsewhere; it is not
  // this function's business to decide it, and treating it as unusable here would hide that report.
  if (text === null) return true;
  return text.length >= 8 && text.length <= 63;
}

function secretValue(value: unknown): string {
  if (isStoredSecret(value)) {
    const inner = value.$secret;
    const text = Array.isArray(inner) ? inner.join('\n') : inner;
    if (text === '') {
      throw new Error('a secret needed by a generated file is stored empty; refusing to generate it');
    }
    return text;
  }
  if (typeof value === 'string' && value !== '') return value;
  throw new Error(
    'a secret needed by a generated file is missing or still redacted. An imported profile must have ' +
      'its gaps filled before it can be applied.',
  );
}
