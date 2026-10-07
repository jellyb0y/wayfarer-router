import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  profileApi,
  type DriftResponse,
  type ObserversResponse,
  type StatusResponse,
  type SystemResponse,
} from '../lib/api.ts';
import { t } from '../lib/i18n.ts';
import { Card, LongValue, RowList, Screen, type Row } from '../components/ui/index.tsx';

/**
 * Status answers one question: **is it working, and if not, what is wrong?**
 *
 * It used to answer a different one. Six tables — units, interfaces, access points, installed
 * components, the clock and the hardware warnings — each true, none of them the question somebody
 * arrives with. A reader had to know which unit names matter and which `NO-CARRIER` flags are
 * ordinary before any of it meant "working" or "not working", and that knowledge is ours, not
 * theirs. So the same readings now produce a verdict first and the specific faults second.
 *
 * **The inventory is not here.** What the device is made of sat folded at the bottom of this screen
 * while Settings did not exist, and it moved there whole rather than being copied: a second
 * inventory would agree with the first until somebody changed one of them, and duplicate controls for
 * the same field in different places is one of the four things Epic E deletes.
 *
 * Everything renders from the last snapshot the event stream delivered, falling back to a fetch
 * only for the first paint: a device whose uplink is down still shows its own state at once.
 */
export function Status({ live }: { live: StatusResponse | null }): ReactElement {
  const system = useQuery({ queryKey: ['system'], queryFn: api.system });
  const fetched = useQuery({ queryKey: ['status'], queryFn: api.status, enabled: live === null });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: profileApi.list });
  /*
   * The comparison with the stored profile.
   *
   * Fetched rather than taken from the status snapshot, because it is not part of it: the daemon
   * makes this comparison at boot, after every undo and on its own cadence, and this screen reads the
   * last one it made rather than asking for a fresh one on every paint.
   */
  const drift = useQuery({ queryKey: ['drift'], queryFn: api.drift });
  // Refetched on a cadence: the whole point of this card is to show a watcher going quiet, and a
  // reading fetched once when the screen opened would go quiet with it.
  const observers = useQuery({ queryKey: ['observers'], queryFn: api.observers, refetchInterval: 30_000 });
  const status = live ?? fetched.data ?? null;

  const faults = status === null ? [] : findFaults(status, system.data);
  const active = profiles.data?.profiles.find((profile) => profile.active) ?? null;

  return (
    <Screen title={t('nav.status')}>
      <Verdict status={status} faults={faults} />

      {faults.length > 0 ? (
        <Card title={t('status.problems')}>
          <RowList
            rows={faults.map((fault) => ({
              id: fault.id,
              title: fault.what,
              badge: <span className={`pill ${fault.severity}`}>{fault.severity === 'bad' ? 'down' : 'check'}</span>,
              fields: [{ label: t('status.where'), value: fault.where }],
            }))}
            empty=""
          />
        </Card>
      ) : null}

      <MatchesProfile drift={drift.data ?? null} />

      <Watching observers={observers.data ?? null} />

      <Card title={t('status.accessPoints')}>
        <RowList rows={accessPointRows(status)} empty={t('status.noAccessPoint')} />
      </Card>

      <Card title={t('status.uplink')}>
        <RowList rows={uplinkRows(status)} empty={t('status.noUplink')} />
      </Card>

      <Card title={t('status.tunnels')}>
        <p className="muted">{active ? active.name : t('status.noProfile')}</p>
        {/*
          * Deliberately empty rather than inferred.
          *
          * This device measures tunnel health directly; the reading simply does not reach the
          * interface yet. The available shortcut — colouring a tunnel by whether its unit is active
          * — would answer a different question in the same words: a unit runs perfectly while the
          * far end refuses every connection. A guess that looks like a measurement is worse than a
          * blank, because nobody goes looking behind a green tick.
          */}
        <p className="muted">{t('status.tunnelHealthPending')}</p>
      </Card>
    </Screen>
  );
}

/* ── is this device running what it was told to run? ─────────────────────────────────────── */

/**
 * The answer to the one question nothing on this device used to ask.
 *
 * Two failures it exists for, both measured on the bench board. On 2026-09-22 six blocked endpoints
 * stood in the stored profile while the running core configuration held none, and the only way to
 * learn it was to read the file and the database by hand. On 2026-09-21 the core kept asking a
 * resolver address its peer had stopped handing out, name resolution stopped for every client on the
 * network, and every screen showed a healthy tunnel.
 *
 * **The pending-changes indicator elsewhere in this interface does not answer this.** That one
 * compares the draft being edited with the stored document — it is about unsaved work, and says
 * nothing at all about whether the files on this device match what was saved.
 *
 * Every divergence shows both values. A row that said "the core configuration differs" would send
 * somebody to a terminal, which is what this replaces.
 */
function MatchesProfile({ drift }: { drift: DriftResponse | null }): ReactElement {
  const report = drift?.report ?? null;
  // Never has looked, could not look, and looked and found nothing are three different sentences.
  const state = report === null ? 'unknown' : report.state;
  const tone = state === 'converged' ? 'ok' : state === 'diverged' || state === 'unreadable' ? 'bad' : 'warn';
  const headline =
    state === 'converged'
      ? t('status.matchesProfileOk')
      : state === 'diverged'
        ? t('status.matchesProfileDiverged')
        : state === 'unreadable'
          ? t('status.matchesProfileUnreadable')
          : state === 'no-profile'
            ? t('status.matchesProfileNoProfile')
            : t('status.matchesProfileNo');

  return (
    <Card title={t('status.matchesProfile')}>
      <p className={`pill ${tone}`}>{headline}</p>
      {drift?.ageSeconds == null ? null : (
        <p className="muted">{`${t('status.checkedAgo')}: ${describeAge(drift.ageSeconds)}`}</p>
      )}
      <RowList
        rows={(report?.findings ?? []).map((finding, index) => ({
          id: `${finding.subject}:${finding.pointer ?? ''}:${String(index)}`,
          title: finding.pointer === null ? finding.subject : `${finding.subject} ${finding.pointer}`,
          fields: [
            { label: t('status.profileSays'), value: <LongValue value={finding.stored ?? '—'} /> },
            { label: t('status.deviceHolds'), value: <LongValue value={finding.running ?? '—'} /> },
            { label: t('status.whatToDo'), value: finding.hint },
          ],
        }))}
        empty=""
      />
    </Card>
  );
}

/* ── is everything that watches the world actually watching it? ───────────────────────────── */

/**
 * Every mechanism on the device that watches or waits for something, with when it last looked, what
 * it saw, when it last acted, and — as a problem, never as an absence — when it is not running.
 *
 * The resolver follower on the bench board did nothing for ten hours on 2026-09-22 and no screen could
 * have said so: it spoke only when it acted, so a follower that had stopped and one with nothing to do
 * looked the same. Here they do not. Problems are listed first, and the ones that are fine are still
 * listed with what they last saw, because "running and idle" is an answer and a blank is not.
 */
function Watching({ observers }: { observers: ObserversResponse | null }): ReactElement {
  const tone = observers === null ? 'warn' : observers.problems > 0 ? 'bad' : 'ok';
  const headline =
    observers === null
      ? t('status.watchingUnknown')
      : observers.problems > 0
        ? t('status.watchingProblems')
        : t('status.watchingOk');
  const order = { 'not-running': 0, failing: 1, stale: 2, ok: 3 } as const;
  const rows = [...(observers?.observers ?? [])].sort((a, b) => order[a.state] - order[b.state]);

  return (
    <Card title={t('status.watching')}>
      <p className={`pill ${tone}`}>{headline}</p>
      <RowList
        rows={rows.map((observer) => ({
          id: observer.name,
          title: observer.name,
          badge: (
            <span className={`pill ${observer.state === 'ok' ? 'ok' : observer.state === 'stale' ? 'warn' : 'bad'}`}>
              {observer.state === 'ok'
                ? t('status.observerOk')
                : observer.state === 'stale'
                  ? t('status.observerStale')
                  : observer.state === 'failing'
                    ? t('status.observerFailing')
                    : t('status.observerNotRunning')}
            </span>
          ),
          fields: [
            ...(observer.problem === null ? [] : [{ label: t('status.problems'), value: <LongValue value={observer.problem} mono={false} lines={3} /> }]),
            {
              label: t('status.lastLooked'),
              value: <LongValue value={observer.lastLooked === null ? t('status.never') : `${describeAge(observer.lastLooked.ageSeconds)}: ${observer.lastLooked.what}`} mono={false} lines={2} />,
            },
            // One row per subject — per guard — so every one is shown however long its note is. A single
            // string cut at a length hid the fourth guard on the bench board, 2026-09-23.
            // The subject goes in the value, not the label: a label cannot wrap, and a tunnel named by a
            // 253-character domain pushed the screen to 1950 px at the 360 px check.
            /*
             * A measured subject says three things: how it was measured, what was found, and what was
             * done. For a tunnel that reads dead the third is the one that matters — the guard no longer
             * blocks, so the panel has to say so rather than leave a red word to be read as "blocked".
             */
            ...(observer.lastLooked?.items ?? []).map((item) => ({
              label: t('status.observerItem'),
              value: (
                <div className="observer-item">
                  {item.tone === undefined ? null : <span className={`pill ${item.tone}`}>{item.state}</span>}
                  <LongValue
                    value={`${item.subject}: ${item.tone === undefined ? item.state : ''}${
                      item.method === undefined ? '' : `${item.tone === undefined ? ' ' : ''}by ${item.method}`
                    }${item.note === null ? '' : ` — ${item.note}`}`}
                    mono={false}
                    lines={2}
                  />
                  {item.action === undefined ? null : (
                    <LongValue value={`${t('status.observerDid')}: ${item.action}`} mono={false} lines={3} />
                  )}
                </div>
              ),
            })),
            {
              label: t('status.lastActed'),
              value: <LongValue value={observer.lastActed === null ? t('status.never') : `${describeAge(observer.lastActed.ageSeconds)}: ${observer.lastActed.what}`} mono={false} lines={2} />,
            },
          ],
        }))}
        empty=""
      />
    </Card>
  );
}

/**
 * How old the last comparison is, from the daemon's monotonic clock.
 *
 * The seconds come from `performance.now()` on the device, not from subtracting two wall-clock
 * instants: this board has no clock battery, and the wall clock can step by days while the daemon is
 * running. So the number arrives already computed and this only words it.
 */
function describeAge(seconds: number): string {
  if (seconds < 90) return `${String(Math.max(0, Math.round(seconds)))}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${String(minutes)}m` : `${String(Math.round(minutes / 60))}h`;
}

/* ── the verdict ─────────────────────────────────────────────────────────────────────────── */

/**
 * Three states, and the third one is the reason this is a function rather than a boolean.
 *
 * A screen that has not heard from the device yet must not draw "working": an absent answer and a
 * good one are the same colour to a reader, and the moment this screen matters most is the moment
 * the device has stopped answering. So "no reading yet" is drawn as its own state, in its own
 * words.
 */
function Verdict({ status, faults }: { status: StatusResponse | null; faults: Fault[] }): ReactElement {
  if (status === null) {
    return (
      <section className="verdict unknown">
        <strong>{t('status.verdictUnknown')}</strong>
      </section>
    );
  }
  const worst = faults.some((fault) => fault.severity === 'bad') ? 'bad' : faults.length > 0 ? 'warn' : 'ok';
  return (
    <section className={`verdict ${worst}`}>
      <strong>
        {worst === 'ok' ? t('status.verdictOk') : worst === 'bad' ? t('status.verdictBad') : t('status.verdictWarn')}
      </strong>
      {faults.length > 0 ? <span className="muted">{faults.length}</span> : null}
    </section>
  );
}

interface Fault {
  id: string;
  what: string;
  where: string;
  severity: 'bad' | 'warn';
}

/**
 * What is wrong, from readings the device already publishes.
 *
 * Every entry here names a subsystem's own account of itself — a unit's `activeState`, a link's
 * `operstate`, the clock's `synchronized` — rather than something inferred from the shape of the
 * whole. Nothing on this screen concludes that a tunnel is down; the tunnel says so or nothing is
 * claimed.
 */
function findFaults(status: StatusResponse, system: SystemResponse | undefined): Fault[] {
  const faults: Fault[] = [];

  for (const unit of Object.values(status.units)) {
    if (!unit.known) continue;
    if (!unit.isActive) {
      faults.push({
        id: `unit:${unit.unit}`,
        what: t('status.faultUnitStopped'),
        where: unit.unit,
        severity: 'bad',
      });
    } else if (!unit.isEnabled) {
      // Active now, absent after the next reboot. Both readings are shown everywhere in this
      // project for that reason, and a difference between them is a fault somebody should see.
      faults.push({
        id: `unit-boot:${unit.unit}`,
        what: t('status.faultUnitNotEnabled'),
        where: unit.unit,
        severity: 'warn',
      });
    }
  }

  if (status.clock?.synchronized === false) {
    faults.push({ id: 'clock', what: t('status.faultClock'), where: t('status.clock'), severity: 'warn' });
  }

  for (const [name, ap] of Object.entries(status.accessPoints)) {
    if (ap.status?.state != null && ap.status.state !== 'ENABLED') {
      faults.push({ id: `ap:${name}`, what: t('status.faultApDown'), where: name, severity: 'bad' });
    }
  }

  for (const binary of system?.binaries ?? []) {
    if (!binary.present) {
      faults.push({ id: `bin:${binary.name}`, what: t('status.faultMissing'), where: binary.name, severity: 'warn' });
    }
  }

  return faults;
}

/* ── rows ────────────────────────────────────────────────────────────────────────────────── */

function accessPointRows(status: StatusResponse | null): Row[] {
  return Object.entries(status?.accessPoints ?? {}).map(([name, ap]) => ({
    id: name,
    title: <span className="mono">{name}</span>,
    badge: (
      <span className={`pill ${ap.status?.state === 'ENABLED' ? 'ok' : 'bad'}`}>
        {ap.status?.state ?? t('common.unknown')}
      </span>
    ),
    fields: [
      {
        label: t('status.channel'),
        value: ap.status?.channel == null ? '—' : `${ap.status.channel}${ap.status.frequencyMhz ? ` · ${ap.status.frequencyMhz} MHz` : ''}`,
      },
      { label: t('status.clients'), value: String(ap.stations.length) },
    ],
  }));
}

function uplinkRows(status: StatusResponse | null): Row[] {
  return Object.entries(status?.links ?? {}).map(([name, link]) => ({
    id: name,
    title: <span className="mono">{name}</span>,
    badge: (
      <span className={`pill ${link.connected ? 'ok' : 'bad'}`}>
        {link.connected ? t('status.connected') : t('status.disconnected')}
      </span>
    ),
    fields: [
      { label: t('status.network'), value: link.ssid ? <LongValue value={link.ssid} label={t('status.network')} /> : '—' },
      { label: t('status.signal'), value: link.signalDbm == null ? '—' : `${link.signalDbm} dBm` },
      { label: t('status.rate'), value: link.txBitrate?.mbps == null ? '—' : `${link.txBitrate.mbps} Mbit/s` },
    ],
  }));
}



