/**
 * Generating the access-point configuration.
 *
 * Every capability written here comes from what the driver published for the bound radio. Nothing in
 * this file contains a channel list, a capability string or a mode table — an access-point
 * configuration that claims a capability the driver does not have simply fails to start, and it
 * fails without saying which claim was the problem.
 *
 * Two shapes that are silent failures if ignored:
 *
 * * **An empty capability line is omitted entirely.** `ht_capab=` with nothing after it is a syntax
 *   error, not a default, and the service refuses to start on it.
 * * **A control interface must be defined**, or none of the access-point state or client events can
 *   be read at all. It is not optional plumbing; it is the only way to see whether the access point
 *   is up.
 */

import type { ProfileDocument } from '@wayfarer/schemas';
import type { RadioInventory } from '../../inventory/index.ts';
import { generatedHeader } from '../desired-state.ts';
import { bandCapabilities } from '../radio-capabilities.ts';

/** Where hostapd's control socket lives. The events subscriber and the state reader both use it. */
/**
 * Re-exported from the platform layer, which owns it.
 *
 * One definition, imported by both the code that writes `ctrl_interface=` and the code that connects
 * to it. Two copies is how they came to disagree, and the disagreement was silent: hostapd started
 * fine, the socket existed, and every call to read its state failed.
 */
import { HOSTAPD_CONTROL_DIR } from '../../platform/ap.ts';

export { HOSTAPD_CONTROL_DIR };

export interface HostapdInput {
  profile: ProfileDocument;
  interfaceName: string;
  radio: RadioInventory;
  passphrase: string;
  /**
   * True when the channel is not ours to choose: the radio hosts the access point and a client
   * together on a single channel, and the client follows the upstream network.
   */
  channelFollowsUplink: boolean;
}

export function generateHostapd(input: HostapdInput): string {
  const accessPoint = input.profile.accessPoint;
  if (accessPoint === null) throw new Error('generateHostapd called for a profile with no access point');

  const { radio, interfaceName } = input;
  const lines: string[] = [];

  lines.push(generatedHeader('#', input.profile.meta.name).trimEnd());
  lines.push(`# Radio: ${radio.phy}. Capabilities below are what this driver published, not defaults.`);
  lines.push('');

  lines.push(`interface=${interfaceName}`);
  lines.push('driver=nl80211');
  lines.push('');
  lines.push('# Without a control interface there is no way to read access-point state or see a client');
  lines.push('# arrive. An access point that produces no events looks exactly like an idle one.');
  lines.push(`ctrl_interface=${HOSTAPD_CONTROL_DIR}`);
  lines.push('ctrl_interface_group=0');
  lines.push('');

  lines.push(`ssid=${accessPoint.ssid}`);

  /**
   * `country_code=00` is rejected by hostapd, and the world domain is a real state of real hardware.
   *
   * Measured on the bench board, hostapd 2.10, with the built-in radio whose own regulatory domain is
   * `00: DFS-UNSET`:
   *
   * ```
   * Line 14: Invalid country_code '00'
   * Cannot enable IEEE 802.11d without setting the country_code
   * 2 errors found in configuration file /etc/wayfarer/hostapd/wlan0.conf
   * ```
   *
   * `00` is how the kernel says "no country has been established", and `iw reg get` reports it
   * routinely — so it is not a bad value to be rejected upstream, it is a value hostapd has no way to
   * express. Written through, it produces a configuration the planner accepts and hostapd refuses.
   *
   * That mattered more than an ordinary generator bug: the **recovery profile** takes its country from
   * the radio's reported domain, so on this board the one document whose entire job is to make the
   * device reachable could not start its access point. A recovery profile that cannot come up is worse
   * than none, because it looks like an answer.
   *
   * So the two lines are omitted together. They have to be: `ieee80211d` without a country is the
   * second of the two errors above, and emitting one without the other trades a clear failure for a
   * confusing one.
   */
  const country = accessPoint.radio.country;
  if (country === '00') {
    lines.push('# No country_code: this radio reports the world regulatory domain (00), which hostapd');
    lines.push('# rejects as a country code. 802.11d is omitted with it, because hostapd refuses that');
    lines.push('# too without a country. The driver still enforces whatever domain the kernel holds.');
  } else {
    lines.push(`country_code=${country}`);
    // The driver enforces the regulatory domain whatever this file says; setting it makes hostapd
    // refuse an out-of-domain channel up front rather than starting and being silently limited.
    lines.push('ieee80211d=1');
  }
  lines.push(`ignore_broadcast_ssid=${accessPoint.radio.hidden === true ? 1 : 0}`);
  lines.push('');

  const band = accessPoint.radio.band;
  lines.push(`hw_mode=${band === '2.4GHz' ? 'g' : 'a'}`);

  if (input.channelFollowsUplink) {
    lines.push('');
    lines.push('# This radio hosts the access point and a client on one channel, and the client follows');
    lines.push('# the upstream network. channel=0 means "use the channel the radio is already on", which');
    lines.push('# is the only correct value here: a fixed number would either be ignored or refused.');
    lines.push('channel=0');
  } else {
    lines.push(`channel=${accessPoint.radio.channel}`);
  }
  lines.push('');

  // 802.11n and 802.11ac are enabled only when the driver published the corresponding capabilities
  // **for the band this access point runs on**. Taking the first band with frequencies validated a
  // 5 GHz access point against a 2.4 GHz band's capabilities on any dual-band radio.
  const bandReport = bandCapabilities(radio, band);
  const ht = bandReport?.htCapabilitiesHex ?? null;
  const vht = bandReport?.vhtCapabilitiesHex ?? null;
  const width = accessPoint.radio.width;

  if (ht !== null) {
    lines.push('ieee80211n=1');
    lines.push('wmm_enabled=1');
    const htCapab = htCapabilities(ht, width);
    // Omitted rather than emitted empty: `ht_capab=` with nothing after it is a syntax error.
    if (htCapab !== '') lines.push(`ht_capab=${htCapab}`);
  }

  if (vht !== null && band !== '2.4GHz') {
    lines.push('ieee80211ac=1');
    const vhtCapab = vhtCapabilities(vht);
    if (vhtCapab !== '') lines.push(`vht_capab=${vhtCapab}`);
    lines.push(`vht_oper_chwidth=${vhtChannelWidth(width)}`);
    if (width >= 80) {
      lines.push(`vht_oper_centr_freq_seg0_idx=${centreChannel(accessPoint.radio.channel, width)}`);
    }
  }

  const he = bandReport?.heIftypes ?? [];
  if (he.includes('AP')) {
    lines.push('');
    lines.push('# 802.11ax, enabled because this driver reports HE support for AP mode specifically —');
    lines.push('# HE capabilities are published per interface type, and a radio can support it as a');
    lines.push('# client and not as an access point.');
    lines.push('ieee80211ax=1');
  }

  lines.push('');
  lines.push('# WPA2 and WPA3 together with CCMP only: TKIP caps the whole network at 54 Mbit/s and is');
  lines.push('# broken. sae_require_mfp with the mixed mode lets a WPA3 client get management-frame');
  lines.push('# protection without excluding a WPA2 one.');
  lines.push('wpa=2');
  lines.push('wpa_key_mgmt=WPA-PSK SAE');
  lines.push('wpa_pairwise=CCMP');
  lines.push('rsn_pairwise=CCMP');
  lines.push('ieee80211w=1');
  lines.push('sae_require_mfp=1');
  lines.push(`wpa_passphrase=${input.passphrase}`);

  const maxStations = radio.reported.maxAssociatedStations;
  if (maxStations !== null) {
    lines.push('');
    lines.push(`# The driver's own limit, not a policy of ours.`);
    lines.push(`max_num_sta=${maxStations}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * The HT capability flags this radio actually has, from the hexadecimal word the driver reported.
 *
 * Only the flags hostapd names are emitted, and only when the corresponding bit is set. The bit
 * positions are from the 802.11 HT Capabilities Info field, which is why they are constants here and
 * not discovered — the *values* come from the driver; the layout of the field is the standard's.
 */
export function htCapabilities(hex: string, width: number): string {
  const value = Number.parseInt(hex.replace(/^0x/i, ''), 16);
  if (!Number.isFinite(value)) return '';
  const capabilities: string[] = [];

  if (value & 0x0001) capabilities.push('[LDPC]');
  // Bit 1 is "supported channel width set": 40 MHz operation. Emitted only when the profile asks for
  // it as well, because announcing 40 MHz on a 20 MHz configuration is a mismatch hostapd rejects.
  if (value & 0x0002 && width >= 40) capabilities.push('[HT40+]');
  if (value & 0x0010) capabilities.push('[GF]');
  if (value & 0x0020) capabilities.push('[SHORT-GI-20]');
  if (value & 0x0040 && width >= 40) capabilities.push('[SHORT-GI-40]');
  if (value & 0x0080) capabilities.push('[TX-STBC]');
  if ((value & 0x0300) !== 0) capabilities.push('[RX-STBC1]');
  if (value & 0x0800) capabilities.push('[MAX-AMSDU-7935]');
  if (value & 0x1000) capabilities.push('[DSSS_CCK-40]');

  return capabilities.join('');
}

/**
 * The VHT capability flags. Observed on the bench board's built-in radio: `0x01b07031` — 80 MHz
 * supported, 160 MHz and 80+80 not, which is exactly the distinction this function has to preserve.
 */
export function vhtCapabilities(hex: string): string {
  const value = Number.parseInt(hex.replace(/^0x/i, ''), 16);
  if (!Number.isFinite(value)) return '';
  const capabilities: string[] = [];

  const maxMpdu = value & 0x0003;
  if (maxMpdu === 1) capabilities.push('[MAX-MPDU-7991]');
  if (maxMpdu === 2) capabilities.push('[MAX-MPDU-11454]');

  // Bits 2–3, the supported channel width set: 1 means 160 MHz, 2 means 160 and 80+80. A radio that
  // reports 0 here supports 80 MHz at most, and claiming 160 makes it fail to start.
  const widthSet = (value >> 2) & 0x0003;
  if (widthSet === 1) capabilities.push('[VHT160]');
  if (widthSet === 2) capabilities.push('[VHT160-80PLUS80]');

  if (value & 0x0010) capabilities.push('[RXLDPC]');
  if (value & 0x0020) capabilities.push('[SHORT-GI-80]');
  if (value & 0x0040) capabilities.push('[SHORT-GI-160]');
  if (value & 0x0080) capabilities.push('[TX-STBC-2BY1]');
  if (value & 0x0800) capabilities.push('[SU-BEAMFORMEE]');
  if (value & 0x00080000) capabilities.push('[RX-ANTENNA-PATTERN]');
  if (value & 0x00100000) capabilities.push('[TX-ANTENNA-PATTERN]');

  return capabilities.join('');
}

function vhtChannelWidth(width: number): number {
  if (width >= 160) return 2;
  if (width >= 80) return 1;
  return 0;
}

/**
 * The centre-frequency index for a wide channel.
 *
 * Derived arithmetically from the primary channel rather than from a table, because a table of
 * channel groups is a table describing a regulatory domain, and those differ.
 */
export function centreChannel(primary: number, width: number): number {
  const channelsWide = width / 20;
  const groupSize = channelsWide * 4;
  const base = Math.floor((primary - 36) / groupSize) * groupSize + 36;
  return base + (channelsWide - 1) * 2;
}
