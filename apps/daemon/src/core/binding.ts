/**
 * Resolving a profile's hardware bindings, and generating the names the rest of the system uses.
 *
 * A profile references hardware by a *selector* rather than an interface name, because `wlan0` is
 * not portable to another device and is not even stable on one — plugging in a dongle can renumber
 * things. Resolution happens at plan time and yields a concrete interface, plus a `systemd.link`
 * file so that name is stable across reboots.
 *
 * ## An unresolved binding is a state, not an error
 *
 * When a profile is imported onto different hardware, or a dongle is unplugged, the affected roles
 * report as `unbound` and the interface offers the detected candidates. That is deliberately not a
 * validation failure: a profile that is legal on one device and illegal on another cannot be
 * shared, and shareable whole documents are the point of the model. A profile cannot be *activated*
 * while a required role is unbound, and the API says which role and why.
 *
 * ## Ambiguity is a refusal, never a coin flip
 *
 * Two identical USB radios make `bind.by: "phy-usb"` match both. Picking the first is stable within
 * one boot and arbitrary across boots, so an access point would move between radios — with
 * different antennas, and possibly a different regulatory view — for no reason anybody could see.
 * The resolver therefore reports `ambiguous` with the candidates, and the fix is a `bus-path`
 * selector, which is the one selector that separates two identical devices.
 *
 * ## Renaming is a choice, and it is off by default
 *
 * An earlier revision of this file renamed every role's interface to a deterministic name of ours
 * and pinned it with a `systemd.link` file, unconditionally. The benefit is real — a name matched on
 * the permanent address survives a USB device re-enumerating, including before this daemon has run —
 * but the cost was not thought through, and it is large: a rename needs the link down, so it takes
 * effect only at the next boot, which made first-time setup on *any* device demand a reboot before
 * the configuration it had just been given was real. And the rename most likely to be wanted is on
 * the interface carrying the operator's own session, which is the riskiest change in the system.
 *
 * So `pinName` is a per-role field, off by default. Unpinned, `name` is whatever the kernel already
 * calls the interface and **no `.link` file is written at all**, so nothing is renamed and nothing
 * waits for a reboot. Pinned, the role gets the generated name and the `.link` file that makes it
 * stick, and the differ classifies that as the `boot` or `network` change it is.
 *
 * The one case where an unpinned role still gets a generated name: a radio that has no interface yet,
 * where there is no current name to keep. That is reported as a note rather than silently pinned,
 * because inventing a name without a `.link` file to create it is a name nothing will answer to.
 *
 * ## The two name constraints, enforced here because here is where names are made
 *
 * * **At most 15 characters.** The kernel limit; a longer name is rejected at creation.
 * * **No hyphen.** systemd escapes `-` as `\x2d` in unit names, so a template instance for an
 *   interface called `wlan-ap` refers to a device unit `sys-subsystem-net-devices-wlan-ap.device`
 *   while the unit that exists is `…-wlan\x2dap.device`. A `BindsTo=` dependency then never
 *   resolves and stops the service immediately, with no useful error.
 *
 * Both are checked where names are generated rather than where they are read, because a name that
 * has already reached a unit file is a name it is too late to reject.
 */

import type { HardwareBinding } from '@wayfarer/schemas';
import type { InterfaceInventory, Inventory, RadioInventory } from '../inventory/index.ts';

/** The kernel's interface name limit, `IFNAMSIZ - 1`. */
export const MAX_INTERFACE_NAME_LENGTH = 15;

/** What a binding is for. The role decides the generated name, so it is part of the model. */
export type BindingRole =
  | { kind: 'access-point' }
  | { kind: 'uplink'; id: string; index: number }
  | { kind: 'tunnel'; id: string; index: number };

/**
 * One piece of hardware this device reports, and the selector that would bind a role to it.
 *
 * The interface needs a *chooser* over the hardware rather than a text field, because the value is
 * measured and the choice is not: the device can enumerate every radio and every port and still
 * cannot know which of two identical dongles the owner meant for the access point. The list is built
 * here and nowhere else — a classifier on the other side of the API would be a second source of
 * truth, and the kernel makes that trap easy to fall into by reporting a radio with the same link
 * type as a wired port.
 *
 * The measured fields are carried beside the label rather than only inside it, so a screen can
 * compose its own text — and so that two candidates that differ only by port can be *shown* to
 * differ.
 */
export interface BindingCandidate {
  /**
   * The selector that would be written into the profile for this piece of hardware.
   *
   * Chosen to be one that actually distinguishes: see `selectorForRadio`.
   */
  suggestion: HardwareBinding;
  /**
   * False when `suggestion` also matches a sibling.
   *
   * Measured by running the suggestion back through the same matcher the resolver uses, not by a
   * rule of its own. It is reported rather than hidden because the screen must never offer a choice
   * that does not choose: picking such a candidate produces an `ambiguous` binding, which is the
   * exact state the chooser exists to resolve.
   */
  distinct: boolean;
  /**
   * What the suggestion costs, when it is not the selector that would otherwise have been chosen.
   *
   * Present only when a distinguishing selector had to replace one that follows the device — today,
   * a bus path replacing an ambiguous USB identifier. It is carried in the candidate rather than
   * written by the screen because it is a real trade and the screen is where this project states
   * consequences: an identifier follows the device to another port, a bus path follows the port and
   * breaks when the device is moved. A selector that silently changes meaning is worse than one that
   * asks.
   */
  consequence?: string;
  /** One line a person can read. The fields below are the same facts, separately. */
  label: string;
  /** The name the kernel currently uses, or null when this hardware has no interface yet. */
  currentName: string | null;
  mac: string | null;
  busPath: string | null;
  usbId: string | null;
  phy: string | null;
  /**
   * Whether this hardware can be unplugged, or null when nothing measured it.
   *
   * Null for a wired interface: the interface inventory reports no bus, so a `false` there would be
   * a claim nothing observed — and a USB Ethernet adapter is exactly the case it would get wrong.
   */
  removable: boolean | null;
  /** Bands the driver publishes. Empty for a wired interface, where it is a fact rather than a gap. */
  bands: string[];
}

export interface BoundRole {
  state: 'bound';
  /** The interface as the kernel currently calls it, or null when the role has no interface yet. */
  currentName: string | null;
  /**
   * The name every generated artefact will spell out.
   *
   * Equal to `currentName` unless this role asked to be pinned, in which case it is the generated
   * name and `pinned` is true. Reading this rather than `currentName` is what keeps a unit file, a
   * hostapd configuration and a firewall rule naming the same interface.
   */
  name: string;
  /** True when a `.link` file should be written to make `name` stick. */
  pinned: boolean;
  /**
   * The name this role *would* get if it were pinned, whether or not it asked to be.
   *
   * Carried so the interface can offer the choice with the actual name in it rather than describing
   * it, and so a plan review can say what turning it on would rename.
   */
  pinnableName: string;
  mac: string | null;
  phy: string | null;
  /**
   * What this device reports, so the interface can offer the choice.
   *
   * Carried on a *bound* role too, and that is the point of hoisting it: a role that resolved still
   * has to be re-pointed at other hardware by somebody, and a chooser that appears only once the
   * binding is broken is a chooser nobody can reach in time.
   */
  candidates: BindingCandidate[];
}

export interface UnboundRole {
  state: 'unbound';
  reason: string;
  /** What was detected, so the interface can offer a choice instead of an error. */
  candidates: BindingCandidate[];
}

export interface AmbiguousRole {
  state: 'ambiguous';
  reason: string;
  candidates: BindingCandidate[];
}

export type Resolution = BoundRole | UnboundRole | AmbiguousRole;

export class GeneratedNameError extends Error {
  readonly name_: string;

  constructor(message: string, generated: string) {
    super(message);
    this.name = 'GeneratedNameError';
    this.name_ = generated;
  }
}

/**
 * The name a role gets.
 *
 * Deterministic from the role and its index, so re-planning the same profile produces the same
 * names and the differ sees no change. The `wf` prefix makes ownership legible at a glance in
 * `ip link` output, which matters on a device where other software also creates interfaces.
 */
export function generateInterfaceName(role: BindingRole): string {
  const name = (() => {
    switch (role.kind) {
      case 'access-point':
        return 'wfap0';
      case 'uplink':
        return `wfwan${role.index}`;
      case 'tunnel':
        return `wfvpn${role.index}`;
    }
  })();

  assertUsableInterfaceName(name);
  return name;
}

/**
 * Both constraints, checked at the point of generation.
 *
 * Exported because a provider that derives a name of its own — a tunnel daemon naming its
 * interface after a tag, for instance — must go through the same gate. A tag is user input, and
 * user input is where a 20-character name with a hyphen in it comes from.
 */
export function assertUsableInterfaceName(name: string): void {
  if (name.length === 0 || name.length > MAX_INTERFACE_NAME_LENGTH) {
    throw new GeneratedNameError(
      `generated interface name "${name}" is ${name.length} characters; the kernel limit is ` +
        `${MAX_INTERFACE_NAME_LENGTH} and a longer name is rejected when the interface is created`,
      name,
    );
  }
  if (name.includes('-')) {
    throw new GeneratedNameError(
      `generated interface name "${name}" contains a hyphen. systemd escapes "-" as "\\x2d" in unit ` +
        'names, so a template instance for this interface would depend on a device unit that does ' +
        'not exist, and a BindsTo= dependency would stop the service immediately with no useful error.',
      name,
    );
  }
  if (!/^[a-z][a-z0-9]*$/.test(name)) {
    throw new GeneratedNameError(
      `generated interface name "${name}" must be lower-case letters and digits, starting with a letter`,
      name,
    );
  }
}

/** Turns an arbitrary tag into a usable interface name, deterministically. */
export function interfaceNameFromTag(prefix: string, tag: string, maxLength = MAX_INTERFACE_NAME_LENGTH): string {
  // Hyphens and underscores are removed rather than replaced, because a replacement character would
  // have to be one of the very few that are legal, and every one of them can already appear in a
  // tag — so two different tags would silently collapse to the same name.
  const cleaned = tag.toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = `${prefix}${cleaned}`.slice(0, maxLength);
  assertUsableInterfaceName(name);
  return name;
}

/* ── resolution ──────────────────────────────────────────────────────────────────────────── */

export interface ResolveInput {
  binding: HardwareBinding;
  role: BindingRole;
  inventory: Inventory;
  /** True when this role needs a radio rather than any interface. */
  wireless: boolean;
  /**
   * Whether this role asked for a deterministic, pinned name. Defaults to false, which is the
   * profile's default: applying a configuration should not require a reboot to become real.
   */
  pinName?: boolean;
}

/**
 * Resolves one binding against the inventory.
 *
 * Pure: it reads the inventory it is given and nothing else, which is what lets every case below be
 * covered by a synthetic inventory rather than by plugging things into a board.
 */
export function resolveBinding(input: ResolveInput): Resolution {
  const { binding, role, inventory, wireless } = input;
  const pinnableName = generateInterfaceName(role);
  const wantsPin = input.pinName === true;
  /*
   * Computed once, for every outcome, from the same function.
   *
   * Not per branch: a list built in the `ambiguous` arm and again in the `unbound` arm is two copies
   * of one rule, and the copy that is wrong is the one nobody looks at. It is also why the ambiguous
   * arm no longer narrows the list to the radios that collided — the reason already names those, and
   * the chooser's job is to offer everything the device has.
   */
  const candidates = bindingCandidates(inventory, wireless);

  /**
   * Which name the rest of the system will spell out.
   *
   * Unpinned with an interface present: keep the kernel's name, write no `.link` file, rename
   * nothing. Unpinned with no interface at all: the generated name is the only name there is, and it
   * is still not pinned — the caller turns that into a note, because a name with no `.link` file
   * behind it is a name nothing will answer to until something creates the interface.
   */
  const settle = (currentName: string | null): { name: string; pinned: boolean } =>
    wantsPin || currentName === null
      ? { name: pinnableName, pinned: wantsPin }
      : { name: currentName, pinned: false };

  if (wireless) {
    const matches = matchRadios(binding, inventory);
    if (matches.length === 0) {
      return { state: 'unbound', reason: describeMiss(binding, 'radio'), candidates };
    }
    if (matches.length > 1) {
      return {
        state: 'ambiguous',
        reason:
          `${matches.length} radios match this selector (${matches.map((radio) => radio.phy).join(', ')}). ` +
          'Choosing one of them would be arbitrary, and it could differ after a reboot, so the ' +
          'access point would move between radios on its own.',
        candidates,
      };
    }

    const radio = matches[0]!;
    const existing = radio.reported.interfaces.find((entry) => entry.name !== null);
    const currentName = existing?.name ?? null;
    return {
      state: 'bound',
      currentName,
      ...settle(currentName),
      pinnableName,
      mac: existing?.mac ?? radio.reported.macFromSysfs,
      phy: radio.phy,
      candidates,
    };
  }

  const matches = matchInterfaces(binding, inventory);
  if (matches.length === 0) {
    return { state: 'unbound', reason: describeMiss(binding, 'interface'), candidates };
  }
  if (matches.length > 1 && binding.by !== 'any-ethernet') {
    return {
      state: 'ambiguous',
      reason: `${matches.length} interfaces match this selector (${matches.map((entry) => entry.name).join(', ')})`,
      candidates,
    };
  }

  // `any-ethernet` matching several is the expected case, not an ambiguity: the selector says "any",
  // and kernel index order is the stable, stated tiebreak rather than an accident of iteration.
  const chosen = [...matches].sort((a, b) => a.ifindex - b.ifindex)[0]!;
  return {
    state: 'bound',
    currentName: chosen.name,
    ...settle(chosen.name),
    pinnableName,
    mac: chosen.mac,
    phy: chosen.phy,
    candidates,
  };
}

function matchRadios(binding: HardwareBinding, inventory: Inventory): RadioInventory[] {
  return inventory.radios.filter((radio) => {
    switch (binding.by) {
      case 'mac': {
        const wanted = binding.value.toLowerCase();
        // A radio's own sysfs address is not trustworthy — one radio here reports all zeros while
        // its interface has a real address — so the interfaces' addresses are matched too, and an
        // all-zero value never matches because the inventory already reports it as absent.
        if (radio.reported.macFromSysfs?.toLowerCase() === wanted) return true;
        return radio.reported.interfaces.some((entry) => entry.mac?.toLowerCase() === wanted);
      }
      case 'phy-builtin':
        return radio.reported.bus === 'platform' || radio.reported.bus === 'pci';
      case 'phy-usb':
        return radio.reported.bus === 'usb' && radio.reported.usbId?.toLowerCase() === binding.value.toLowerCase();
      case 'bus-path':
        return radio.reported.devicePath === binding.value;
      case 'any-ethernet':
        return false;
    }
  });
}

function matchInterfaces(binding: HardwareBinding, inventory: Inventory): InterfaceInventory[] {
  return inventory.interfaces.filter((entry) => {
    switch (binding.by) {
      case 'mac':
        return entry.mac?.toLowerCase() === binding.value.toLowerCase();
      case 'any-ethernet':
        // Wired means: has a hardware address, is not a radio, is not loopback, and is not a virtual
        // device something else created. `kind` being set is the kernel saying "this is a bridge, a
        // tunnel, a bond" — none of which is a cable.
        return (
          entry.phy === null &&
          entry.mac !== null &&
          entry.name !== 'lo' &&
          entry.kind === null &&
          entry.linkType === 'ether'
        );
      case 'phy-builtin':
      case 'phy-usb':
      case 'bus-path':
        return false;
    }
  });
}

function describeMiss(binding: HardwareBinding, what: string): string {
  switch (binding.by) {
    case 'mac':
      return `no ${what} on this device has the address ${binding.value}`;
    case 'phy-builtin':
      return 'this device reports no built-in radio';
    case 'phy-usb':
      return `no USB radio with the identifier ${binding.value} is plugged in`;
    case 'bus-path':
      return `nothing is attached at ${binding.value}`;
    case 'any-ethernet':
      return 'this device reports no wired interface';
  }
}

/**
 * Everything of the right kind this device reports, as choices.
 *
 * The one place candidates are built. Exported so the API can answer the chooser's question without
 * a rule of its own, and so nothing downstream is tempted to derive this from the inventory a second
 * time.
 *
 * An empty array is an answer: it means this was run and the device has no such hardware. A caller
 * that never ran it must say so by omitting the field, not by sending `[]`.
 */
export function bindingCandidates(inventory: Inventory, wireless: boolean): BindingCandidate[] {
  return wireless ? radioCandidates(inventory) : interfaceCandidates(inventory);
}

/**
 * The selector to suggest for one radio, and whether it had to replace one that follows the device.
 *
 * **The rule this function exists for.** The obvious selector for a removable radio is its USB
 * identifier — but that identifier is a vendor and a product, not a serial number, so *two identical
 * dongles share it* and a suggestion built from it matches both. Suggesting it produces the ambiguous
 * binding the chooser exists to resolve, which makes the suggestion worse than useless: it is a
 * choice that does not choose. The only fact separating two identical dongles is which port they are
 * in, so when the identifier is not unique the suggestion falls back to the bus path.
 *
 * The fallback is stated rather than silent, because it is a real trade in both directions: a USB
 * identifier follows the device into another port, a bus path follows the port and stops matching
 * when the device is moved.
 *
 * Ambiguity is *measured*, by running the candidate selector back through the resolver's own matcher
 * rather than by comparing identifiers here — which is also why the same fallback covers a device
 * with two built-in radios, where `phy-builtin` matches both for a different reason.
 *
 * Returns null when the radio reports nothing that can name it: no identifier, no bus path, no
 * address. Such hardware is left out of the list rather than offered with an unusable selector,
 * because a candidate nothing can select is not a choice.
 */
function selectorForRadio(
  radio: RadioInventory,
  inventory: Inventory,
): { suggestion: HardwareBinding; consequence?: string } | null {
  const { usbId, devicePath, macFromSysfs, interfaces } = radio.reported;
  const removable = radio.derived.removable.value;
  const matchesAlone = (suggestion: HardwareBinding): boolean => matchRadios(suggestion, inventory).length === 1;

  const preferred: HardwareBinding | null = removable
    ? usbId === null
      ? null
      : { by: 'phy-usb', value: usbId }
    : { by: 'phy-builtin' };

  if (preferred !== null && matchesAlone(preferred)) return { suggestion: preferred };

  if (devicePath !== null) {
    const suggestion: HardwareBinding = { by: 'bus-path', value: devicePath };
    if (preferred === null) return { suggestion };
    return {
      suggestion,
      consequence:
        preferred.by === 'phy-usb'
          ? `Another radio reports the same USB identifier (${preferred.value}), so this binding is by ` +
            'bus path: it follows the port rather than the device, and stops matching if this radio is ' +
            'moved to another port.'
          : 'More than one radio answers to the built-in selector, so this binding is by bus path: it ' +
            'follows the port rather than the device.',
    };
  }

  // Nothing distinguishes it. The selector is still the best available one, and `distinct` says what
  // it is worth — an honest "this does not choose" beats a value that cannot match anything at all.
  if (preferred !== null) return { suggestion: preferred };
  const mac = interfaces.find((entry) => entry.mac !== null)?.mac ?? macFromSysfs;
  if (mac !== null) return { suggestion: { by: 'mac', value: mac } };
  return null;
}

function radioCandidates(inventory: Inventory): BindingCandidate[] {
  return inventory.radios.flatMap((radio) => {
    const chosen = selectorForRadio(radio, inventory);
    if (chosen === null) return [];

    const removable = radio.derived.removable.value;
    const bands = radio.derived.bands.value;
    const existing = radio.reported.interfaces.find((entry) => entry.name !== null);
    const currentName = existing?.name ?? null;
    const busPath = radio.reported.devicePath;

    return [
      {
        suggestion: chosen.suggestion,
        // Measured with the matcher that will resolve it later, so the answer cannot drift from the
        // resolution it predicts.
        distinct: matchRadios(chosen.suggestion, inventory).length === 1,
        ...(chosen.consequence === undefined ? {} : { consequence: chosen.consequence }),
        label:
          `${radio.phy}${currentName === null ? '' : ` (${currentName})`} — ` +
          `${removable ? 'a USB radio' : 'built in'}${busPath === null ? '' : ` at ${busPath}`}, ` +
          `${bands.join(' and ') || 'no bands reported'}`,
        currentName,
        mac: existing?.mac ?? radio.reported.macFromSysfs,
        busPath,
        usbId: radio.reported.usbId,
        phy: radio.phy,
        removable,
        bands,
      },
    ];
  });
}

function interfaceCandidates(inventory: Inventory): BindingCandidate[] {
  return inventory.interfaces
    .filter((entry) => entry.phy === null && entry.mac !== null && entry.name !== 'lo')
    .map((entry) => {
      const suggestion: HardwareBinding = { by: 'mac', value: entry.mac! };
      return {
        suggestion,
        distinct: matchInterfaces(suggestion, inventory).length === 1,
        label: `${entry.name} (${entry.mac})`,
        currentName: entry.name,
        mac: entry.mac,
        // The interface inventory reports no bus for a wired port, so these are absences rather than
        // negative answers, and `removable` is null for exactly that reason.
        busPath: null,
        usbId: null,
        phy: null,
        removable: null,
        bands: [],
      };
    });
}

/* ── systemd.link generation ─────────────────────────────────────────────────────────────── */

export interface LinkFile {
  path: string;
  content: string;
  mode: number;
}

/**
 * The `systemd.link` file that pins a name.
 *
 * Matching on **address**, not on the current name: USB devices can be enumerated in a different
 * order between boots, so a name derived from enumeration order is not stable, and the whole reason
 * this file exists is that a unit file and a configuration file both spell the interface out.
 *
 * Returns null when there is no address to match on. That is not a silent skip — the caller reports
 * the role as pinned or not, because an unpinned interface is a name that can move, and a name that
 * moves takes a unit's `BindsTo=` with it.
 *
 * It also returns null for a role that did not ask to be pinned. That is the whole of the `pinName`
 * decision at the point where it has an effect: no file, no rename, no reboot, and the role simply
 * uses the name the kernel already chose.
 */
export function linkFileFor(role: BindingRole, resolved: BoundRole): LinkFile | null {
  if (!resolved.pinned) return null;
  if (resolved.mac === null) return null;

  const roleName = role.kind === 'access-point' ? 'ap' : `${role.kind}-${role.id}`;
  return {
    // The file name may contain hyphens; only the *interface* name may not. Worth stating, because
    // the two constraints sit one line apart and look like the same rule.
    path: `/etc/systemd/network/70-wayfarer-${roleName}.link`,
    content:
      `# Generated by Wayfarer. Edits are overwritten on the next apply.\n` +
      `#\n` +
      `# Matched on the permanent address rather than the current name: USB devices can enumerate in\n` +
      `# a different order between boots, so a name derived from enumeration order is not stable.\n` +
      `[Match]\n` +
      `MACAddress=${resolved.mac}\n` +
      `\n` +
      `[Link]\n` +
      `Name=${resolved.name}\n`,
    mode: 0o644,
  };
}
