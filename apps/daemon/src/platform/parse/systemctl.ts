/**
 * Parsers for `systemctl show` and `timedatectl show`.
 *
 * `systemctl show` ignores `--output=json` (verified on systemd 257.13: the flag is
 * accepted and the output is still key-value text), which is why unit *state* is read
 * over D-Bus and this parser exists only for the paths where the CLI is the tool:
 * `enable`/`disable` verification and the one-shot reads the CLI does exactly.
 */

export interface UnitShow {
  /** Values as printed. Property names are systemd's, not renamed. */
  properties: Record<string, string>;
  id: string | null;
  activeState: string | null;
  subState: string | null;
  unitFileState: string | null;
  loadState: string | null;
  result: string | null;
  /** True only for `active`. `activating` is not active yet. */
  isActive: boolean;
  /**
   * True for `enabled` and `enabled-runtime`, false for `disabled`, `masked`,
   * `static` and the rest. Both this and `isActive` are checked when verifying a
   * change: a restart that fails aborts a sequence, and if enable has not happened the
   * unit is left disabled — a fault that only appears after the next reboot.
   */
  isEnabled: boolean;
}

export function parseSystemctlShow(output: string): UnitShow {
  const properties = parseKeyValueLines(output);
  const unitFileState = properties['UnitFileState'] ?? null;
  return {
    properties,
    id: properties['Id'] ?? null,
    activeState: properties['ActiveState'] ?? null,
    subState: properties['SubState'] ?? null,
    unitFileState,
    loadState: properties['LoadState'] ?? null,
    result: properties['Result'] ?? null,
    isActive: properties['ActiveState'] === 'active',
    isEnabled: unitFileState === 'enabled' || unitFileState === 'enabled-runtime',
  };
}

export interface ClockStatus {
  timezone: string | null;
  /** Whether network time synchronisation is enabled. */
  ntpEnabled: boolean | null;
  /**
   * Whether the clock has actually been synchronised since boot. This board has no
   * clock battery, so after being switched off the clock starts from the last
   * timestamp written before shutdown — which can be days in the past. Transports
   * that authenticate on a timestamp then fail while direct connections work, and it
   * presents as broken tunnels rather than as a broken clock.
   */
  synchronized: boolean | null;
  localRtc: boolean | null;
  timeUsec: string | null;
  rtcTimeUsec: string | null;
}

export function parseTimedatectlShow(output: string): ClockStatus {
  const p = parseKeyValueLines(output);
  return {
    timezone: p['Timezone'] ?? null,
    ntpEnabled: boolOrNull(p['NTP']),
    synchronized: boolOrNull(p['NTPSynchronized']),
    localRtc: boolOrNull(p['LocalRTC']),
    timeUsec: p['TimeUSec'] ?? null,
    rtcTimeUsec: p['RTCTimeUSec'] ?? null,
  };
}

/**
 * Split on the *first* `=` only: several systemd properties contain `=` in their
 * value (`Environment`, `ExecStart`), and splitting on every occurrence truncates
 * them.
 */
export function parseKeyValueLines(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const raw of output.split('\n')) {
    if (raw.trim() === '') continue;
    const idx = raw.indexOf('=');
    if (idx <= 0) continue;
    properties[raw.slice(0, idx)] = raw.slice(idx + 1);
  }
  return properties;
}

function boolOrNull(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (value === 'yes' || value === 'true') return true;
  if (value === 'no' || value === 'false') return false;
  return null;
}

/**
 * systemd escapes characters that are not valid in a unit name, and `-` becomes
 * `\x2d` because `-` is the path separator in unit names. A template instance for an
 * interface called `wlan-ap` therefore refers to the device unit
 * `sys-subsystem-net-devices-wlan\x2dap.device`, while an unescaped name produces
 * `…-wlan-ap.device`, which does not exist — a `BindsTo=` on it never resolves and
 * stops the service immediately, with no useful error.
 *
 * This is the same transformation as `systemd-escape`, implemented here so nothing has
 * to shell out to build a unit name.
 */
export function systemdEscape(value: string): string {
  if (value === '') return '';
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    // A leading dot is escaped, otherwise the unit name would look like a hidden file.
    if (i === 0 && char === '.') {
      out += '\\x2e';
      continue;
    }
    if (/^[A-Za-z0-9:_.]$/.test(char)) {
      out += char;
      continue;
    }
    if (char === '/') {
      out += '-';
      continue;
    }
    out += [...Buffer.from(char, 'utf8')].map((b) => `\\x${b.toString(16).padStart(2, '0')}`).join('');
  }
  return out;
}

/** The device unit name for a network interface, with escaping applied. */
export function deviceUnitForInterface(interfaceName: string): string {
  return `sys-subsystem-net-devices-${systemdEscape(interfaceName)}.device`;
}
