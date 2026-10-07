/**
 * The distribution's own units that contend with ours, and how each one stands on this device.
 *
 * ## Why this exists
 *
 * Observed on the bench board, 2026-09-24: the distribution's `dnsmasq.service` was enabled and failed
 * at every boot, while `wf-dhcp@<ap>.service` — the same binary, run with our configuration only —
 * served addresses and names to the access point's clients. The stock configuration listens on the
 * wildcard address, ours binds the access point's interface, and nothing orders the two: today ours
 * wins. Expected, not yet observed: the day the order flips, the stock unit holds the sockets, ours
 * restarts into its start limit, and every client of the access point associates and gets no address.
 *
 * The installer masks these units (`deploy/install.sh`, `STOCK_UNITS_TO_MASK`). A mask is undone by one
 * command anybody may type, and a package upgrade or a how-to followed on the device can do it too, so
 * the drift check reads their state on every round and reports a unit that is no longer masked.
 *
 * ## One list, two readers
 *
 * The installer is bash and this is TypeScript, so the list is written twice and a test
 * (`test/stock-units.test.ts`) fails when the two differ — in a name or in a reason. Units, not a
 * pattern: each entry is a decision with its own reason, and the reason is what the finding says.
 *
 * ## What is deliberately not here
 *
 * * `wpa_supplicant.service`. It owns the D-Bus name `fi.w1.wpa_supplicant1` and serves every radio on
 *   the device, including ones no profile names. Our uplink runs its own instance without `-u`, on its
 *   own control socket, precisely so that it never contends with this one (`docs/05-platform-layer.md`,
 *   *Wi-Fi*). There is no conflict to remove, and masking it would take a wireless connection this
 *   project was never asked to touch.
 * * `hostapd.service`. It holds no port and no global name: it reads `/etc/hostapd/hostapd.conf`, a
 *   file this project never writes, and acts only on the interface that file names. Our access point
 *   runs from `/etc/wayfarer/hostapd/<if>.conf` with its control sockets under `/run/wayfarer/hostapd`.
 *   The stock unit can contend only for a radio somebody configured it for by hand, which is an
 *   operator's decision rather than a race. (Assumption, from Debian's packaging: the package ships
 *   the unit masked until a configuration exists. To be read on the board, not relied on.)
 */

import type { SystemdController } from './systemd.ts';

export interface ConflictingStockUnit {
  /** The distribution's unit name. */
  unit: string;
  /** Why it is masked, in the words the installer logs and the finding repeats. */
  reason: string;
}

/**
 * Mirrored by `STOCK_UNITS_TO_MASK` in `deploy/install.sh`. Change both, or the test fails.
 */
export const CONFLICTING_STOCK_UNITS: readonly ConflictingStockUnit[] = [
  {
    unit: 'dnsmasq.service',
    reason: 'wf-dhcp@ serves DHCP/DNS on the AP; the stock unit races it for ports 53/67',
  },
];

/**
 * How one of those units stands.
 *
 * * `absent` — systemd has no such unit: the package is not installed. Nothing to say.
 * * `masked` — masked persistently, as the installer leaves it.
 * * `unmasked` — present and not masked persistently. `masked-runtime` is here too: it is masked now
 *   and is not after the next boot, which is when the race happens.
 * * `unreadable` — systemd could not be asked. Never read as `masked`.
 */
export type StockUnitStanding = 'absent' | 'masked' | 'unmasked' | 'unreadable';

export interface StockUnitReading extends ConflictingStockUnit {
  standing: StockUnitStanding;
  /** `UnitFileState` as systemd reported it: `enabled`, `disabled`, `masked-runtime`… or null. */
  unitFileState: string | null;
  /** `ActiveState` as systemd reported it, or null. */
  activeState: string | null;
  /** Why it could not be read, when `standing` is `unreadable`. */
  error?: string;
}

/** Reads every unit in the list. One failure is that unit's `unreadable`, never the whole answer. */
export async function readStockUnits(
  systemd: Pick<SystemdController, 'state'>,
  units: readonly ConflictingStockUnit[] = CONFLICTING_STOCK_UNITS,
): Promise<StockUnitReading[]> {
  const readings: StockUnitReading[] = [];
  for (const entry of units) {
    try {
      const state = await systemd.state(entry.unit);
      readings.push({
        ...entry,
        standing: standingOf(state),
        unitFileState: state.unitFileState ?? null,
        activeState: state.activeState ?? null,
      });
    } catch (error) {
      readings.push({ ...entry, standing: 'unreadable', unitFileState: null, activeState: null, error: String(error) });
    }
  }
  return readings;
}

/**
 * Pure, so every standing is reachable from a fixture.
 *
 * Existence comes from `known`, the controller's reading of `LoadState`, exactly as the reality read and
 * capability reporting take it (`platform/facts.ts`). A unit systemd cannot resolve therefore reads
 * `absent`, the answer every other unit question in this daemon gives; a controller that throws is the
 * one reading that is `unreadable`.
 */
export function standingOf(state: { known: boolean; unitFileState: string | null }): StockUnitStanding {
  if (!state.known) return 'absent';
  // `UnitFileState` rather than `LoadState`: a runtime mask also loads as `masked`, and it is gone at
  // the next boot.
  if (state.unitFileState === 'masked') return 'masked';
  return 'unmasked';
}
