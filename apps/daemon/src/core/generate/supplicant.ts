/**
 * Generating the wireless client configuration — the uplink half of the radio.
 *
 * `wpa_supplicant` associates the device with somebody else's access point. Its configuration file
 * is the one place in this project where a value the operator typed is copied into a format with its
 * own quoting rules, and that is where this generator earns its existence.
 *
 * ## The SSID is written in hexadecimal, deliberately
 *
 * An SSID is **32 bytes of anything**. It is not text. It may hold leading or trailing spaces, tabs,
 * bytes that are not valid UTF-8, or a double quote. `wpa_supplicant` accepts either a quoted string
 * or a bare hex sequence, and only the hex form is unambiguous:
 *
 * * `ssid="VINTAGE "` relies on every layer between the operator and the file preserving a trailing
 *   space that is invisible in every interface that displays it;
 * * `ssid=56494e5441474520` cannot lose it, cannot be re-indented by an editor, and cannot be broken
 *   by an SSID containing a quote or a backslash.
 *
 * This is not a way around the trailing-space problem, it is the encoding that does not have one. The
 * human-readable form is written above it as a comment, with the invisible characters spelled out, so
 * that a person reading the file can still see which network it is.
 *
 * Measured on the bench network, 2026-09-20: the router's SSID is `VINTAGE ` — seven letters and a
 * trailing space — which is exactly the case that a `.trim()` anywhere in the stack turns into a
 * network that does not exist and an error message that says nothing useful.
 *
 * ## The passphrase is turned into a key, not copied
 *
 * WPA-PSK's key is PBKDF2 over the passphrase **and the SSID**. `wpa_supplicant` will do that itself
 * from `psk="…"`, but then the operator's passphrase sits in a file in plain text, and it sits there
 * inside a quoted string with its own escaping rules — the second place a stray backslash changes the
 * value silently. Deriving the 256-bit key here writes `psk=<64 hex>` instead: no quoting, no
 * escaping, and the passphrase itself never reaches the disk.
 *
 * The derivation binds the key to the SSID, so an SSID change must regenerate the file. It does: the
 * SSID is an input to this function and the differ compares content.
 */

import { pbkdf2Sync } from 'node:crypto';
import type { Uplink } from '@wayfarer/schemas';
import { generatedHeader } from '../desired-state.ts';

/**
 * Re-exported from the platform layer, which owns it.
 *
 * One definition, imported by both the code that writes `ctrl_interface=` and the code that connects
 * to it. Two copies is how the access point's pair came to disagree, and the disagreement was silent:
 * the service started, a socket existed, and every read of its state failed.
 */
import { SUPPLICANT_CONTROL_DIR } from '../../platform/supplicant-cli.ts';

export { SUPPLICANT_CONTROL_DIR };

export interface SupplicantInput {
  /** The `wifi-sta` uplink this configuration is for. */
  uplink: Extract<Uplink, { kind: 'wifi-sta' }>;
  /** The resolved interface name, used only in the comment header. */
  interfaceName: string;
  /** The profile's name, for the generated header. */
  profileName: string;
  /** The passphrase in the clear, or `null` for an open network. */
  passphrase: string | null;
}

/** The lowest and highest passphrase lengths WPA-PSK defines. Outside them there is no key to derive. */
const PASSPHRASE_MIN = 8;
const PASSPHRASE_MAX = 63;

export class SsidTooLongError extends Error {
  constructor(bytes: number) {
    super(
      `this network name is ${bytes} bytes and the limit is 32. An SSID is measured in bytes, not ` +
        'characters, so a name with accented or non-Latin characters reaches the limit sooner than it looks.',
    );
    this.name = 'SsidTooLongError';
  }
}

export class PassphraseLengthError extends Error {
  constructor(length: number) {
    super(
      `a WPA passphrase is between ${PASSPHRASE_MIN} and ${PASSPHRASE_MAX} characters; this one is ${length}`,
    );
    this.name = 'PassphraseLengthError';
  }
}

export function generateSupplicant(input: SupplicantInput): string {
  const { uplink, interfaceName, profileName, passphrase } = input;
  const ssidBytes = Buffer.from(uplink.config.ssid, 'utf8');
  if (ssidBytes.length > 32) throw new SsidTooLongError(ssidBytes.length);

  const lines: string[] = [];
  lines.push(generatedHeader('#', profileName).trimEnd());
  lines.push(`# The wireless uplink on ${interfaceName}.`);
  lines.push('#');
  lines.push(`# Network name: ${describeSsid(uplink.config.ssid)}`);
  lines.push('# Written as hexadecimal below because an SSID is 32 bytes of anything, and a quoted');
  lines.push('# string cannot carry every byte unambiguously. The comment above is the readable form.');
  lines.push('');

  // Root only: this file holds the network key.
  lines.push(`ctrl_interface=DIR=${SUPPLICANT_CONTROL_DIR} GROUP=root`);
  /**
   * The control socket above is the **only** way the daemon learns what this interface is doing, so
   * it is not optional plumbing — it is the event source.
   *
   * It is under our own directory rather than the distribution's `/run/wpa_supplicant`, for the same
   * reason the access point's is: this project does not share a namespace. Sharing one here is not
   * merely untidy, it is impossible — see the platform module for what a shared *D-Bus* name cost.
   *
   * `update_config=0` because this file is generated. A supplicant allowed to write its own
   * configuration back would produce a file the next apply overwrites, which is the worst of both:
   * changes that appear to stick and then vanish.
   */
  lines.push('update_config=0');
  lines.push('');
  lines.push('network={');
  lines.push(`\tssid=${ssidBytes.toString('hex')}`);

  if (uplink.config.bssid !== undefined && uplink.config.bssid !== null) {
    lines.push(`\tbssid=${uplink.config.bssid.toLowerCase()}`);
  }

  /**
   * A hidden network is not found by a passive scan, so the supplicant has to ask for it by name.
   * Without this the association simply never happens and nothing says why.
   */
  if (uplink.config.hidden === true) lines.push('\tscan_ssid=1');

  if (passphrase === null) {
    // An open network. Saying so explicitly is required: the default is not "no security".
    lines.push('\tkey_mgmt=NONE');
  } else {
    if (passphrase.length < PASSPHRASE_MIN || passphrase.length > PASSPHRASE_MAX) {
      throw new PassphraseLengthError(passphrase.length);
    }
    lines.push('\tkey_mgmt=WPA-PSK WPA-PSK-SHA256 SAE');
    // WPA3 needs the passphrase itself, so a key-only file cannot do SAE. Recorded rather than hidden:
    // this configuration associates with WPA2 and with WPA3 networks that still accept WPA2.
    lines.push(`\tpsk=${derivePsk(passphrase, uplink.config.ssid)}`);
    lines.push('\tieee80211w=1');
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * The 256-bit WPA-PSK, as 64 hex characters.
 *
 * PBKDF2-HMAC-SHA1, 4096 iterations, the SSID as the salt, 32 bytes out. Those numbers are the
 * standard's, not a choice: a different iteration count produces a key the access point will reject.
 */
export function derivePsk(passphrase: string, ssid: string): string {
  return pbkdf2Sync(Buffer.from(passphrase, 'utf8'), Buffer.from(ssid, 'utf8'), 4096, 32, 'sha1').toString('hex');
}

/**
 * An SSID rendered for a human, with the characters that do not show themselves spelled out.
 *
 * `VINTAGE ` becomes `"VINTAGE␠"`. The point is that a person comparing the configuration against
 * the sticker on a router can see the difference between a name and the same name with a space on
 * the end, which is the whole reason this case is being handled deliberately.
 */
export function describeSsid(ssid: string): string {
  const shown = [...ssid]
    .map((character) => {
      if (character === ' ') return '␠';
      if (character === '\t') return '␉';
      const code = character.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, '0')}`;
      return character;
    })
    .join('');
  const bytes = Buffer.from(ssid, 'utf8').length;
  const note = shown === ssid ? '' : ' (␠ marks a space, ␉ a tab — they are part of the name)';
  return `"${shown}", ${bytes} byte${bytes === 1 ? '' : 's'}${note}`;
}
