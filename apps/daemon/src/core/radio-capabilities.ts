/**
 * Which band's capabilities apply to a configured access point.
 *
 * ## Why this is a function and not two lines in two files
 *
 * Both the invariant check and the hostapd generator used to take `bands.find(b => b.frequencyCount >
 * 0)` — the first band with any frequencies at all. On a dual-band radio that is the 2.4 GHz band, so
 * an access point configured for 5 GHz was validated against, and generated from, the wrong band's HT
 * and VHT capabilities.
 *
 * It was masked by the hardware: the bench board's radios each publish one band, so the first band is
 * always the right one there. That is exactly why it had to be fixed before it could be observed — the
 * failure needs somebody else's dual-band radio to appear, and it appears as an access point that
 * refuses to start, or one that starts with capabilities it does not have.
 *
 * Two copies of a wrong lookup is also the signal that it wanted to be one function.
 */

import type { InventoryChannel, RadioInventory } from '../inventory/index.ts';

export type Band = '2.4GHz' | '5GHz' | '6GHz';

/** The band report whose frequencies fall in the requested band, or null when the radio has none. */
export function bandCapabilities(
  radio: RadioInventory,
  band: Band,
): RadioInventory['reported']['bands'][number] | null {
  const channelsInBand = radio.derived.channels.filter((channel) => channel.band === band);
  if (channelsInBand.length === 0) return null;

  // The driver publishes bands by index and channels with frequencies; the link between them is the
  // frequency count, which is the only field both sides carry. Matching on it is exact when the counts
  // differ and ambiguous when they do not — so a single candidate is taken, and otherwise the band's
  // position among the bands that have frequencies is used, which is the order the driver prints them.
  const withFrequencies = radio.reported.bands.filter((entry) => entry.frequencyCount > 0);
  if (withFrequencies.length === 0) return null;
  if (withFrequencies.length === 1) return withFrequencies[0]!;

  const exact = withFrequencies.filter((entry) => entry.frequencyCount === channelsInBand.length);
  if (exact.length === 1) return exact[0]!;

  const order: Band[] = ['2.4GHz', '5GHz', '6GHz'];
  const present = order.filter((candidate) =>
    radio.derived.channels.some((channel) => channel.band === candidate),
  );
  const position = present.indexOf(band);
  return position >= 0 && position < withFrequencies.length ? withFrequencies[position]! : null;
}

/** The channels this radio offers in one band. */
export function channelsInBand(radio: RadioInventory, band: Band): InventoryChannel[] {
  return radio.derived.channels.filter((channel) => channel.band === band);
}
