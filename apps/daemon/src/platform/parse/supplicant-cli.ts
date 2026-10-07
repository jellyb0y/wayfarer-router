/**
 * Parsing `wpa_cli` output: `status` replies and unsolicited events.
 *
 * Pure, so it can be tested without a radio, a socket or a supplicant.
 */

export interface SupplicantStatus {
  interfaceName: string | null;
  /** `DISCONNECTED`, `SCANNING`, `ASSOCIATING`, `4WAY_HANDSHAKE`, `COMPLETED`… */
  state: string | null;
  ssid: string | null;
  bssid: string | null;
  frequencyMhz: number | null;
  ipAddress: string | null;
}

export type SupplicantCliEvent =
  | { kind: 'connected'; bssid: string | null }
  | { kind: 'disconnected'; reason: string | null }
  | { kind: 'scan-done'; success: boolean }
  | { kind: 'auth-failed' }
  | { kind: 'state'; state: string };

/**
 * `wpa_cli status` is `key=value` per line.
 *
 * **The SSID is not decoded or trimmed.** `wpa_cli` prints it with non-printable bytes escaped as
 * `\xNN` and everything else verbatim, so a name with a trailing space arrives with that space on
 * the end of the line. Trimming the value — as opposed to the line ending — is exactly the bug the
 * `VINTAGE ` fixture exists to catch, so only `\r` and `\n` are removed.
 */
export function parseSupplicantStatus(text: string): SupplicantStatus {
  const values = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '' || line.startsWith('Selected interface')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    values.set(line.slice(0, at), line.slice(at + 1));
  }
  const frequency = Number(values.get('freq'));
  return {
    interfaceName: values.get('ifname') ?? null,
    state: values.get('wpa_state') ?? null,
    ssid: values.get('ssid') ?? null,
    bssid: values.get('bssid') ?? null,
    frequencyMhz: Number.isFinite(frequency) && frequency > 0 ? frequency : null,
    ipAddress: values.get('ip_address') ?? null,
  };
}

/**
 * One unsolicited event line, or `null` for anything that is not one.
 *
 * `wpa_cli` prefixes them with a priority in angle brackets — `<3>CTRL-EVENT-CONNECTED …`. Lines
 * without that prefix are command replies, the interactive banner or the prompt, and are not events.
 */
export function parseSupplicantCliEvent(line: string): SupplicantCliEvent | null {
  const match = /^<\d+>(.*)$/.exec(line.trim());
  if (!match) return null;
  const body = match[1]!;

  if (body.startsWith('CTRL-EVENT-CONNECTED')) {
    const bssid = /- Connection to ([0-9a-fA-F:]{17})/.exec(body)?.[1] ?? null;
    return { kind: 'connected', bssid: bssid === null ? null : bssid.toLowerCase() };
  }
  if (body.startsWith('CTRL-EVENT-DISCONNECTED')) {
    return { kind: 'disconnected', reason: /reason=(\d+)/.exec(body)?.[1] ?? null };
  }
  if (body.startsWith('CTRL-EVENT-SCAN-RESULTS')) return { kind: 'scan-done', success: true };
  if (body.startsWith('CTRL-EVENT-SCAN-FAILED')) return { kind: 'scan-done', success: false };
  // The one a person actually needs to see: the key is wrong. It arrives as its own event rather
  // than as a disconnect with a reason code nobody can read.
  if (body.startsWith('CTRL-EVENT-SSID-TEMP-DISABLED') && body.includes('auth_failures')) {
    return { kind: 'auth-failed' };
  }
  if (body.startsWith('CTRL-EVENT-ASSOC-REJECT')) return { kind: 'auth-failed' };
  const state = /^CTRL-EVENT-STATE-CHANGE .*state=(\S+)/.exec(body)?.[1];
  if (state !== undefined) return { kind: 'state', state };
  return null;
}
