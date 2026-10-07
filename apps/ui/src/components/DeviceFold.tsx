/**
 * What the device is made of, rather than whether it is working.
 *
 * ## Why this is a fold on Settings and not a screen
 *
 * It answers real questions — is the core even installed, is the clock right, which unit will not
 * come back after a reboot — and none of them is *is it working*, which is the one question Status
 * exists for. It lived on Status only because Settings did not exist yet, and it moves here **whole**
 * rather than being copied: "duplicate controls for the same field in different places" is one of the
 * four things Epic E deletes, and a second inventory that agreed with the first until somebody
 * changed one of them is that defect with a delay on it.
 *
 * ## Almost nothing here is a control, and the one that is belongs here
 *
 * Every *reading* is one the device already publishes, and `GET /api/system` is read-only — there is
 * no write route for the device's name, and the plan records that as a decision rather than a gap. So
 * the name sits beside the version as information. It carries no note explaining that it cannot be
 * changed, because the rule is about **a blank where an answer belongs**, and an information row with
 * no control beside it promises nothing. A screen that annotated every fact it cannot edit would grow
 * back the paragraphs this epic is removing.
 *
 * The exception is `/services/clashApi/enabled`, and it is here rather than on Network because it is
 * not a question about the network: it is whether this device runs a second control API at all, which
 * is the same kind of fact as which binaries are installed. It was reachable from our own API and from
 * no screen — a piece of power that could be switched on without the interface ever mentioning it.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type StatusResponse, type SystemResponse } from '../lib/api.ts';
import { readAt } from '../lib/draft.ts';
import { t } from '../lib/i18n.ts';
import { CheckField, Fold, LongValue, RowList, type Row } from './ui/index.tsx';
import { Capabilities } from './Capabilities.tsx';

export function DeviceFold({
  status,
  document,
}: {
  status: StatusResponse | null;
  /** The draft, when one has loaded. `null` while it has not: the fold's readings do not need it. */
  document?: Record<string, unknown> | null;
}): ReactElement {
  const system = useQuery({ queryKey: ['system'], queryFn: api.system });

  return (
    <Fold summary={t('status.device')}>
      <dl className="row-fields">
        <Pair label={t('status.name')} value={system.data?.deviceName ?? t('common.unknown')} />
        <Pair label={t('status.version')} value={system.data?.version ?? '—'} />
        <Pair label={t('status.runtime')} value={system.data?.runtime ?? '—'} />
        <Pair
          label={t('status.uptime')}
          value={system.data ? `${Math.round(system.data.uptimeSeconds / 60)} min` : '—'}
        />
        <div className="row-field">
          <dt>{t('status.listening')}</dt>
          <dd>
            {system.data ? (
              <LongValue
                value={`${system.data.listen.addresses.join(', ')}:${system.data.listen.port}`}
                label={t('status.listening')}
              />
            ) : (
              '—'
            )}
          </dd>
        </div>
        <Pair label={t('status.api')} value={system.data?.apiEnabled ? t('common.yes') : t('common.no')} />
        <Pair
          label={t('status.clock')}
          value={
            status?.clock?.synchronized == null
              ? t('common.unknown')
              : status.clock.synchronized
                ? t('status.clockOk')
                : t('status.clockWrong')
          }
        />
      </dl>

      {/*
        * A second control API, and the sentence says what it is rather than what it is called. It
        * listens on loopback only and is reached through this panel's own authentication, which is
        * why turning it off costs nothing a person here uses — and why leaving it on unexamined is
        * power nobody chose.
        */}
      {document == null ? null : (
        <CheckField
          pointer="/services/clashApi/enabled"
          label="Core control API"
          checked={readAt(document, '/services/clashApi/enabled') !== false}
          help="The proxy core's control interface, on loopback; nothing on these screens needs it."
        />
      )}

      <Fold summary={t('status.units')} count={Object.keys(status?.units ?? {}).length}>
        <RowList rows={unitRows(status)} empty={t('common.loading')} />
      </Fold>

      <Fold summary={t('status.interfaces')} count={status?.network?.links?.length}>
        <RowList rows={interfaceRows(status)} empty={t('common.loading')} />
      </Fold>

      {/*
        * What this device *can do*, beside what it is made of. It answers the question a missing
        * component raises — "and what do I type to fix it?" — which the component list alone does not.
        */}
      <Capabilities />

      <Fold summary={t('status.binaries')} count={system.data?.binaries.length}>
        <RowList rows={binaryRows(system.data)} empty={t('common.loading')} />
      </Fold>

      {(system.data?.warnings ?? []).length > 0 ? (
        <Fold summary={t('status.warnings')} count={system.data?.warnings.length}>
          {(system.data?.warnings ?? []).map((warning) => (
            <p className="note" key={warning}>
              {warning}
            </p>
          ))}
        </Fold>
      ) : null}
    </Fold>
  );
}

function Pair({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="row-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function unitRows(status: StatusResponse | null): Row[] {
  return Object.values(status?.units ?? {}).map((unit) => ({
    id: unit.unit,
    title: <span className="mono">{unit.unit}</span>,
    badge: <span className={`pill ${unit.isActive ? 'ok' : 'bad'}`}>{unit.activeState ?? t('common.unknown')}</span>,
    fields: [
      { label: t('status.running'), value: `${unit.activeState ?? '?'}${unit.subState ? ` / ${unit.subState}` : ''}` },
      { label: t('status.atBoot'), value: unit.unitFileState ?? t('status.noUnitFile') },
    ],
  }));
}

function interfaceRows(status: StatusResponse | null): Row[] {
  return (status?.network?.links ?? []).map((link) => ({
    id: link.name,
    title: <span className="mono">{link.name}</span>,
    badge: (
      <span className={`pill ${link.operstate === 'UP' ? 'ok' : link.flags.includes('NO-CARRIER') ? 'warn' : ''}`}>
        {link.operstate ?? '?'}
      </span>
    ),
    // Flags are a long unbreakable-looking run of capitals, and the list grows with the kernel.
    fields: [{ label: t('status.flags'), value: <LongValue value={link.flags.join(' ')} label={t('status.flags')} /> }],
  }));
}

function binaryRows(system: SystemResponse | undefined): Row[] {
  return (system?.binaries ?? []).map((binary) => ({
    id: binary.name,
    title: <span className="mono">{binary.name}</span>,
    badge: (
      <span className={`pill ${binary.present ? 'ok' : 'warn'}`}>
        {binary.present ? (binary.version ?? t('status.installed')) : t('status.notInstalled')}
      </span>
    ),
    fields: [
      {
        label: binary.present ? t('status.path') : t('status.neededFor'),
        value: <LongValue value={binary.present ? (binary.path ?? '—') : binary.neededFor} />,
      },
    ],
  }));
}
