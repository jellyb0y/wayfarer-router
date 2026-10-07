/**
 * Daemon configuration: where to listen, where state lives, how loud to log.
 *
 * The bind set is **configuration resolved through interface names**, not a heuristic.
 * Deriving it from "every address that is not on the default route" was considered and
 * rejected: the one failure it can produce is publishing the management interface on the
 * uplink, and it produces it silently whenever the default route is missing or moves.
 * Interface names in a configuration file are allowed — an operator states which interface
 * is the management one; an address baked into code is not.
 *
 * With no configuration file at all the daemon listens on loopback only. That is the safe
 * default: unreachable from the network is recoverable over SSH, whereas reachable from the
 * uplink is not recoverable at all.
 */

import { readFile } from 'node:fs/promises';

export interface ListenConfig {
  port: number;
  /** Literal addresses to bind. */
  addresses: string[];
  /** Interfaces whose current addresses are bound, re-resolved on address changes. */
  interfaces: string[];
}

export interface DaemonConfig {
  listen: ListenConfig;
  stateDir: string;
  /** Directory for caches: the core's schema, keyed by version and build tags. */
  cacheDir: string;
  /** Where the interface's static files are, or null to serve none. */
  uiDir: string | null;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Unit name this daemon runs as, used when reading its own logs. */
  unitName: string;
  /**
   * Ports time synchronisation uses, so the firewall bypass can be written in terms of them.
   *
   * Configuration rather than a constant in the generator: a value hardcoded there could not be
   * corrected on a device that uses a different one.
   */
  timePorts: number[];
  /** The unit to restart for time synchronisation — after the firewall, never before. */
  timeSyncUnit: string;
  /**
   * Time servers, as **IP literals**.
   *
   * Literals and not names, and this is a hardware fact rather than a preference. The resolver does not
   * run as root and name resolution is exactly what is unavailable when the clock is wrong — so a
   * server given by name cannot be reached in the situation the clock matters. A board with no battery
   * starts from the last timestamp written before shutdown, which can be days in the past, and
   * timestamp-authenticated transports refuse a session in that state: every tunnel fails while every
   * direct connection works, which reads as broken tunnels and is a broken clock.
   *
   * They live in **daemon configuration and not in a profile**. A profile is a shareable document, and
   * time servers chosen for one network have no business being applied to a stranger's device because
   * they pasted a configuration.
   */
  timeServers: string[];
  /** The operator CLI, for the command line of the transient revert unit. */
  wayBinary: string;
  /** Tool paths, for a distribution that puts them elsewhere. */
  paths: Record<string, string>;
}

export const DEFAULT_CONFIG: DaemonConfig = {
  /**
   * Loopback, plus whatever the **active profile's** management surfaces resolve to.
   *
   * `interfaces` is empty by default and that no longer means "loopback only": the access point and — unless
   * the profile turns it off — the uplink are derived from the profile at plan time and bound in addition to
   * this list. So a fresh device needs no file edited, which matters because the documentation tells a new
   * owner to join the access point and open the panel.
   *
   * The list survives as the way an operator adds a surface the profile does not describe. Removing it would
   * break a device somebody has already configured that way.
   */
  listen: { port: 8088, addresses: ['127.0.0.1'], interfaces: [] },
  stateDir: '/var/lib/wayfarer',
  cacheDir: '/var/lib/wayfarer/cache',
  uiDir: '/opt/wayfarer/ui',
  logLevel: 'info',
  unitName: 'wayfarer.service',
  timePorts: [123],
  timeSyncUnit: 'systemd-timesyncd.service',
  // Anycast literals, which is the whole point: they resolve to nothing and require no resolver.
  // Two providers rather than one, so a single operator's outage does not leave a board unable to
  // learn the time — which on this hardware means unable to bring up a tunnel.
  timeServers: ['162.159.200.1', '162.159.200.123', '216.239.35.0', '216.239.35.4'],
  wayBinary: '/usr/local/bin/way',
  paths: {},
};

/**
 * The access-point credentials a **fresh** device starts with, printed by the installer.
 *
 * Fixed and documented rather than generated, because the recovery story matters more here than the
 * window it closes: a documented default is something an operator can act on when they have forgotten
 * everything and are standing in front of a device with no console, and a value printed once during an
 * install months ago is not. The window is closed by force instead — the device refuses every scope
 * until both this and the admin password have been changed.
 *
 * **Not** what safe mode falls back to when a configured device drops into it. See
 * `buildRecoveryDocument`: safe mode keeps the operator's own network name and passphrase wherever they
 * are usable, because changing them is the one thing that would stop their phone reconnecting at the
 * moment they most need to reach the device.
 */
export const DEFAULT_AP_SSID = 'Wayfarer';
export const DEFAULT_AP_PASSPHRASE = 'wayfarer';

export const CONFIG_PATH = '/etc/wayfarer/daemon.json';

export interface LoadedConfig {
  config: DaemonConfig;
  /** Path actually read, or null when defaults were used. */
  source: string | null;
  /** Problems that did not stop the daemon, for the log and for `way doctor`. */
  warnings: string[];
}

export async function loadConfig(path = CONFIG_PATH): Promise<LoadedConfig> {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { config: DEFAULT_CONFIG, source: null, warnings: [`no configuration at ${path}; listening on loopback only`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A malformed configuration must not widen the bind set: the daemon starts on loopback
    // and says why, rather than guessing at what was meant.
    return {
      config: DEFAULT_CONFIG,
      source: path,
      warnings: [`${path} is not valid JSON (${String(error)}); using defaults, listening on loopback only`],
    };
  }

  return { config: mergeConfig(parsed, warnings), source: path, warnings };
}

export function mergeConfig(parsed: unknown, warnings: string[]): DaemonConfig {
  if (!isRecord(parsed)) {
    warnings.push('configuration is not an object; using defaults');
    return DEFAULT_CONFIG;
  }

  const listenRaw = isRecord(parsed['listen']) ? parsed['listen'] : {};
  const port = asNumber(listenRaw['port']) ?? DEFAULT_CONFIG.listen.port;
  if (port < 1 || port > 65535) warnings.push(`listen.port ${port} is out of range; using ${DEFAULT_CONFIG.listen.port}`);

  const addresses = asStringArray(listenRaw['addresses']);
  const interfaces = asStringArray(listenRaw['interfaces']);
  if (addresses.length === 0 && interfaces.length === 0) {
    warnings.push(
      'listen.addresses and listen.interfaces are both empty; the only surfaces will be the ones the active ' +
        'profile resolves to',
    );
  }

  const logLevel = asString(parsed['logLevel']);
  const validLevels = ['trace', 'debug', 'info', 'warn', 'error'] as const;
  const level = validLevels.find((candidate) => candidate === logLevel) ?? DEFAULT_CONFIG.logLevel;

  return {
    listen: {
      port: port >= 1 && port <= 65535 ? port : DEFAULT_CONFIG.listen.port,
      // Loopback is always bound: the operator CLI and the update flow talk to the daemon
      // locally, and they must keep working when a profile removes every other address.
      addresses: addresses.includes('127.0.0.1') ? addresses : ['127.0.0.1', ...addresses],
      interfaces,
    },
    stateDir: asString(parsed['stateDir']) ?? DEFAULT_CONFIG.stateDir,
    cacheDir: asString(parsed['cacheDir']) ?? `${asString(parsed['stateDir']) ?? DEFAULT_CONFIG.stateDir}/cache`,
    uiDir: parsed['uiDir'] === null ? null : (asString(parsed['uiDir']) ?? DEFAULT_CONFIG.uiDir),
    logLevel: level,
    unitName: asString(parsed['unitName']) ?? DEFAULT_CONFIG.unitName,
    timePorts: asNumberArray(parsed['timePorts'], DEFAULT_CONFIG.timePorts),
    timeSyncUnit: asString(parsed['timeSyncUnit']) ?? DEFAULT_CONFIG.timeSyncUnit,
    // Validated by shape: a name here would be silently useless, because the reason these are literals
    // is that no resolver is available when they are needed.
    timeServers: validTimeServers(asStringArray(parsed['timeServers']), warnings),
    wayBinary: asString(parsed['wayBinary']) ?? DEFAULT_CONFIG.wayBinary,
    paths: isRecord(parsed['paths'])
      ? Object.fromEntries(
          Object.entries(parsed['paths']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : {},
  };
}

/**
 * Turns the configured bind set into concrete addresses. Interface names are resolved
 * against the addresses the kernel reports right now; an interface with no address yet
 * contributes nothing and is reported, because "bound to nothing" must be visible rather
 * than looking like a successful start.
 */
export function resolveBindAddresses(
  listen: ListenConfig,
  addresses: { name: string; address: string; family: string }[],
): { bind: string[]; unresolved: string[] } {
  const bind = new Set<string>(listen.addresses);
  const unresolved: string[] = [];

  for (const interfaceName of listen.interfaces) {
    const matching = addresses.filter((entry) => entry.name === interfaceName && entry.family === 'inet');
    if (matching.length === 0) {
      unresolved.push(interfaceName);
      continue;
    }
    for (const entry of matching) bind.add(entry.address);
  }

  return { bind: [...bind], unresolved };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNumberArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return fallback;
  const numbers = value.filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry > 0 && entry < 65536);
  return numbers.length > 0 ? numbers : fallback;
}

/**
 * Keeps only entries that are IP literals, and says which were dropped.
 *
 * A hostname here is not a small mistake to tolerate quietly: the entire reason these are literals is
 * that name resolution is unavailable in the situation they exist for, so a name would produce a board
 * that cannot correct its clock and therefore cannot bring up a timestamp-authenticated tunnel — a
 * failure that presents as broken tunnels. Dropped with a warning rather than accepted.
 */
function validTimeServers(values: string[], warnings: string[]): string[] {
  if (values.length === 0) return DEFAULT_CONFIG.timeServers;
  const literal = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/;
  const kept = values.filter((value) => literal.test(value));
  for (const value of values) {
    if (!literal.test(value)) {
      warnings.push(
        `timeServers entry "${value}" is not an IP literal and was ignored: the clock has to be ` +
          'correctable when name resolution is unavailable, which is exactly when it is needed.',
      );
    }
  }
  return kept.length > 0 ? kept : DEFAULT_CONFIG.timeServers;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];
}
