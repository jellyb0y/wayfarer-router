/**
 * Unit state as plain data, with no D-Bus dependency.
 *
 * Separated from the systemd controller on purpose: these two functions are pure, they encode the
 * rule that decides whether a service is actually healthy, and they are the part worth testing on a
 * device that has no development dependencies installed. Importing them used to drag the D-Bus
 * binding in, which meant the tests could not run on the board at all.
 */

export interface UnitState {
  unit: string;
  /** `active`, `inactive`, `failed`, `activating`, `deactivating`. */
  activeState: string | null;
  /** `running`, `exited`, `dead`, `start-pre`… the finer state within `activeState`. */
  subState: string | null;
  /** `enabled`, `enabled-runtime`, `disabled`, `static`, `masked`, or null when unknown. */
  unitFileState: string | null;
  loadState: string | null;
  isActive: boolean;
  isEnabled: boolean;
  /**
   * Whether a unit by this name exists at all.
   *
   * Taken from `LoadState`, not from `ActiveState`: measured on the board, asking systemd about a
   * name that does not exist returns `inactive` / `dead` / `not-found` rather than an error, so a
   * check based on the active state calls every typo a stopped service. Capability reporting
   * depends on telling "installed but not running" from "not installed".
   */
  known: boolean;
}

/**
 * A unit is only considered healthy when it is **both** active and enabled. Checking one is how a
 * device works today and comes up without the service in the morning: a restart that fails aborts a
 * sequence, and if enable has not run the unit is left disabled.
 */
export function unitIsHealthy(state: UnitState): boolean {
  return state.isActive && state.isEnabled;
}

export function normaliseUnitState(unit: string, properties: Record<string, unknown>): UnitState {
  const activeState = asString(properties['ActiveState']);
  const unitFileState = asString(properties['UnitFileState']);
  const loadState = asString(properties['LoadState']);
  return {
    unit,
    activeState,
    subState: asString(properties['SubState']),
    // systemd returns an empty string, not an absent property, for a unit with no unit file. Empty
    // is unknown here: "" is not a state anyone can act on.
    unitFileState: unitFileState === '' ? null : unitFileState,
    loadState,
    isActive: activeState === 'active',
    isEnabled: unitFileState === 'enabled' || unitFileState === 'enabled-runtime',
    known: loadState !== null && loadState !== 'not-found',
  };
}

export function unknownUnitState(unit: string): UnitState {
  return {
    unit,
    activeState: null,
    subState: null,
    unitFileState: null,
    loadState: null,
    isActive: false,
    isEnabled: false,
    known: false,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
