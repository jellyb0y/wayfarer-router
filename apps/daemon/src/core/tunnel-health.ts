/**
 * Why a tunnel that keeps resetting is usually a certificate, and why the clock is the first suspect.
 *
 * An external tunnel that connects, drops and reconnects in a loop produces a very recognisable
 * pattern — a unit with a climbing restart count and a log full of TLS handshake failures — and the
 * two overwhelmingly common causes are both about time:
 *
 * * **the certificate has expired**, which is ordinary and which the operator can see for themselves
 *   once somebody tells them where to look; and
 * * **this device's clock is wrong**, which makes a perfectly valid certificate look expired, and
 *   which is not ordinary at all — it is the normal state of a board with no battery-backed clock that
 *   has just been powered on somewhere with no working time source.
 *
 * The second is the one worth going out of the way for. A device whose clock reads 1970 rejects every
 * certificate it is shown, reports a TLS failure for each one, and gives an operator every reason to
 * believe their provider is at fault. The message therefore names the clock **first** whenever the
 * clock is not known to be good, because that ordering is the difference between an operator checking
 * one thing and an operator replacing credentials that were never wrong.
 */

export interface ResetObservation {
  tunnelId: string;
  /** Restarts systemd has counted for this tunnel's unit. */
  restarts: number;
  /** How long the unit has been running in its current attempt, in seconds. */
  activeSeconds: number;
  /**
   * Whether this device's clock is known to be right.
   *
   * `false` covers both "not synchronised yet" and "we could not tell" — deliberately, because an
   * unverified clock and a wrong one produce the same certificate failures, and a warning that named
   * the clock only when it was *proved* wrong would stay silent in exactly the case it is for.
   */
  clockTrusted: boolean;
}

export interface TunnelWarning {
  tunnelId: string;
  kind: 'resets-look-like-certificate';
  /** Written for an operator, and ordered so the cheapest thing to check comes first. */
  message: string;
  hint: string;
}

/**
 * How many restarts in a row before this is worth saying.
 *
 * Three, for the same reason safe mode uses three: one is a dropped connection, two is a bad evening,
 * and three in quick succession is a configuration that is not going to start working by itself.
 */
export const RESET_WARNING_THRESHOLD = 3;

/**
 * How briefly a tunnel must stay up for a restart to count as "resetting" rather than "running".
 *
 * A tunnel that has been up for an hour and restarts once has not got a certificate problem. The
 * pattern being recognised is connect-drop-connect, so the current attempt has to be young.
 */
export const RESET_WARNING_MAX_UPTIME_SECONDS = 120;

export function certificateResetWarning(observation: ResetObservation): TunnelWarning | null {
  if (observation.restarts < RESET_WARNING_THRESHOLD) return null;
  if (observation.activeSeconds > RESET_WARNING_MAX_UPTIME_SECONDS) return null;

  const clockFirst = !observation.clockTrusted;
  return {
    tunnelId: observation.tunnelId,
    kind: 'resets-look-like-certificate',
    message:
      `The tunnel "${observation.tunnelId}" has reconnected ${observation.restarts} times and has not ` +
      'stayed up. That pattern is almost always about time rather than about the network: ' +
      (clockFirst
        ? "**this device's clock is not known to be correct**, and a device whose clock is wrong " +
          'rejects certificates that are perfectly valid. Check the clock before anything else.'
        : 'the most common cause is an expired certificate.'),
    hint: clockFirst
      ? 'Check the date on this device first. If it is wrong, nothing about the tunnel is at fault and ' +
        'replacing credentials will not help. If it is right, check whether the certificate has expired.'
      : 'Check whether the certificate in this tunnel’s configuration has expired, then whether the ' +
        'provider has changed it.',
  };
}

/* ── what a tunnel's units add up to ─────────────────────────────────────────────────────── */

/**
 * What the **units** of a tunnel are doing. Not whether traffic passes.
 *
 * The name is `service` and not `state`, `health` or `up`, and the distance between those words is
 * the whole reason this type exists. Nothing on this device measures a handshake, a key negotiation
 * or a byte through a tunnel. Measured on the bench board, 2026-09-21: one tunnel's unit stayed
 * `active` for an hour while never once completing key negotiation, and another answered its own
 * resource in half a second while the guard in front of it refused every connection. Both would read
 * `running` here, and both would be correct readings of the wrong question.
 *
 * So: `running` means every unit of the tunnel is active. It does not mean the tunnel works.
 */
export type TunnelServiceState = 'running' | 'stopped' | 'unknown';

/** One unit of a tunnel, as `systemctl show` answered for it. */
export interface TunnelUnitReading {
  unit: string;
  /** `ActiveState`, or `null` when the unit could not be read at all. */
  activeState: string | null;
  /** `LoadState`. `not-found` and `null` both mean there is no unit here to judge. */
  loadState: string | null;
  /** `NRestarts`, or `null` when it could not be read. Never defaulted to zero — see below. */
  restarts: number | null;
  /**
   * `ActiveEnterTimestampMonotonic`, converted to seconds since boot, or `null`.
   *
   * **Monotonic, never `ActiveEnterTimestamp`.** The wall-clock property is recorded in whatever
   * frame the clock was in when the unit started. This board has no battery-backed clock, so a step
   * of years the moment a time source appears is ordinary rather than hypothetical — and after one,
   * a client subtracting the wall-clock value from its own `now` gets a duration that never happened.
   * Seconds since boot plus the machine's uptime puts both numbers on one clock, which is the whole
   * of the fix.
   */
  activeEnterSinceBootSeconds: number | null;
}

/** What one tunnel's units add up to. The shape that reaches the wire. */
export interface TunnelStatus {
  id: string;
  /**
   * An **aggregate over this tunnel's units**, and it says nothing about whether traffic passes.
   * See `TunnelServiceState`: a tunnel whose units are all active reads `running` whether it is
   * carrying the owner's traffic or failing every handshake.
   */
  service: TunnelServiceState;
  /**
   * The **largest** restart count among the tunnel's units, or `null` when none could be read.
   *
   * The maximum and never the sum. A reconnection restarts the transport and the tunnel it carries
   * together, so a sum counts every reconnection twice — and the warning threshold of three, which
   * exists to tell "a bad evening" from "a configuration that will not start working", would then be
   * crossed at two reconnections.
   *
   * `null` rather than `0` when nothing could be read, because `0` is the reassuring answer — never
   * restarted — delivered in exactly the case where nobody managed to look.
   */
  restarts: number | null;
  /**
   * The **most recent** active-enter among the tunnel's units, as an ISO timestamp, or `null`.
   *
   * The most recent, because a transport that came up two seconds ago is what the tunnel's current
   * attempt is worth dating from; the oldest would report an age the connection has not had.
   */
  since: string | null;
}

function unitService(reading: TunnelUnitReading): TunnelServiceState {
  // A unit nobody could read and a unit systemd does not have are both `unknown`. A name that does
  // not exist answers `inactive`/`dead`/`not-found` rather than erroring, so judging on the active
  // state alone would report every typo as a stopped tunnel.
  if (reading.activeState === null) return 'unknown';
  if (reading.loadState === null || reading.loadState === 'not-found') return 'unknown';
  if (reading.activeState === 'active') return 'running';
  /*
   * Everything else is `stopped`, `activating` included.
   *
   * `activating` is not carrying traffic, and this field reports what the units are doing rather
   * than what they are about to do. Giving it a fourth value would put a state on the wire that
   * every client has to learn in order to render the two that matter.
   */
  return 'stopped';
}

/**
 * Combine one tunnel's unit readings into one verdict.
 *
 * **A tunnel is not one unit**, which is why this exists at all: an OpenVPN tunnel has one, the same
 * tunnel behind an obfuscation transport has a transport as well, a VLESS tunnel has its client. The
 * rules, each with the reason it beat the obvious alternative:
 *
 * * **any unit stopped wins over any unit unknown.** A component known to be down is a stronger fact
 *   than one nobody could read, and reporting `unknown` for a tunnel whose transport is definitely
 *   dead hides the one thing worth acting on.
 * * **an empty unit list is `unknown`, not `running`.** A tunnel that emitted no units is a tunnel
 *   nothing is being said about; vacuous truth over an empty list would report it as healthy, which
 *   is the "default value of a not-yet-known answer must not be the value that means all clear" rule
 *   this project has already paid for three times.
 */
export function aggregateTunnelStatus(input: {
  id: string;
  units: TunnelUnitReading[];
  /** Seconds since boot when the readings were taken, or `null` when it could not be read. */
  uptimeSeconds: number | null;
  /** Wall-clock milliseconds when the readings were taken. */
  nowMs: number;
}): TunnelStatus {
  const services = input.units.map(unitService);
  const service: TunnelServiceState =
    input.units.length === 0
      ? 'unknown'
      : services.includes('stopped')
        ? 'stopped'
        : services.includes('unknown')
          ? 'unknown'
          : 'running';

  let restarts: number | null = null;
  for (const reading of input.units) {
    if (reading.restarts === null || !Number.isFinite(reading.restarts)) continue;
    restarts = restarts === null ? reading.restarts : Math.max(restarts, reading.restarts);
  }

  /*
   * Without the machine's uptime there is no second number to put the monotonic timestamp on, and
   * the honest answer is `null`. Falling back to `ActiveEnterTimestamp` here would silently reinstate
   * the wall-clock frame this whole field is arranged to avoid.
   */
  let sinceMs: number | null = null;
  if (input.uptimeSeconds !== null && Number.isFinite(input.uptimeSeconds)) {
    for (const reading of input.units) {
      const enteredAt = reading.activeEnterSinceBootSeconds;
      if (enteredAt === null || !Number.isFinite(enteredAt) || enteredAt <= 0) continue;
      // Age within one frame — seconds since boot, both of them — then anchored to wall-clock once.
      const ageSeconds = Math.max(0, input.uptimeSeconds - enteredAt);
      const candidate = input.nowMs - ageSeconds * 1000;
      sinceMs = sinceMs === null ? candidate : Math.max(sinceMs, candidate);
    }
  }

  return {
    id: input.id,
    service,
    restarts,
    since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
  };
}
