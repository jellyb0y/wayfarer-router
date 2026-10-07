/**
 * Which wireless interfaces are worth watching, and what to do when the driver cannot be asked.
 *
 * An interface the driver reports in AP mode is watched as an access point; one in managed mode is
 * watched for link quality. Nothing here names an interface: on this hardware the names differ per
 * board and per boot order, so the roles are a reading rather than a constant.
 *
 * ## The defect this was extracted from
 *
 * This decision lived inside a closure inside `main()`, and `main()` runs on import — so no test
 * could reach it. That is the third decision found in one day living where nothing could call it,
 * after the bind policy's gate and the resolver re-derive verdict, and it is the worst of the three,
 * because it was also wrong.
 *
 * It read the driver as `platform.wifi.phys().catch(() => [])`. **A failed read became an observed
 * absence.** The two results are different claims: `[]` says the driver answered and this device has
 * no radios; a failure says nobody could ask. Collapsing them mattered because the telemetry watch
 * calls *replace* their sets — `watchAccessPoints([])` stops watching every access point — so a
 * single `iw` timeout tore down all wireless telemetry, the station list went empty, and the panel
 * showed nobody connected. The only record was a `debug` line, which nothing prints by default.
 *
 * This repository has already paid for this exact confusion once, on the station list, where "nobody
 * is connected" and "we could not finish asking" were the same empty list. Here it was the same
 * mistake one layer up, in the code that decides what the station list is even about.
 *
 * Note the file it lived in already had the distinction right thirty lines away: the bind path reads
 * the same driver with `.catch(() => null)` precisely so an `ether` link is never guessed to be a
 * wire. Two readings of one driver, in one file, with opposite discipline — which is what a decision
 * nobody can test looks like from the outside.
 */

import type { Radio } from '../platform/wifi.ts';

export interface WirelessRoles {
  /** Interfaces the driver reports in AP mode. */
  accessPoints: string[];
  /** Interfaces the driver reports in managed mode — a client of somebody else's network. */
  links: string[];
}

/**
 * Decide the watch sets from what the driver reported.
 *
 * **`null` in means `null` out**, and the caller must treat that as "keep what you have" rather than
 * as an empty answer. It is expressed as a return value rather than as a thrown error because it is
 * not an error: a device whose radio driver is busy is a normal device, and the right response is to
 * leave the previous sets in place and say so, not to stop watching.
 *
 * An interface with no name is skipped rather than guessed at. An interface in any other mode —
 * monitor, mesh, or something this build has never seen — is in neither set, deliberately: the two
 * sets drive two specific pollers, and a mode neither poller understands is not made to fit one.
 */
export function wirelessRolesFrom(radios: Radio[] | null): WirelessRoles | null {
  if (radios === null) return null;

  const accessPoints: string[] = [];
  const links: string[] = [];
  for (const radio of radios) {
    for (const entry of radio.interfaces) {
      if (entry.name === null) continue;
      if (entry.type === 'AP') accessPoints.push(entry.name);
      else if (entry.type === 'managed') links.push(entry.name);
    }
  }
  return { accessPoints, links };
}

/**
 * The line recorded when the driver could not be asked.
 *
 * Phrased as a gap in observation rather than as a failure of the device, because that is what it
 * is, and because the operator's question when the panel shows nothing is "is it broken or are we
 * not looking?" — which is the question this sentence exists to answer.
 */
export function unreadableRadiosSummary(previous: WirelessRoles): string {
  const watched = [...previous.accessPoints, ...previous.links];
  return (
    'could not ask the driver which wireless interfaces exist, so the watch list was left as it was' +
    `${watched.length > 0 ? `: ${watched.join(', ')}` : ' (nothing was being watched yet)'}. ` +
    'Station and link readings may be stale until the next attempt — they are not evidence that ' +
    'nothing is connected.'
  );
}
