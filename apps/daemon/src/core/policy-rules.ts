/**
 * The policy rules this device depends on, and whether they are there.
 *
 * Two sets, owned by two different units and checked differently:
 *
 * - **The device's own bypass**, installed by `wf-firewall.service` (see `generate/units.ts`): the
 *   device's root-owned traffic and its time queries take the main table, so the tunnel clients reach
 *   their servers directly. Without it those connections loop into the tunnel and every tunnel goes
 *   down. The set is ours, so it is checked rule by rule.
 * - **The core's capture**, installed by the proxy core on start. Its exact shape is the core's, so
 *   only its presence is checked: at least one rule looking up {@link CORE_ROUTE_TABLE}.
 *
 * Measured on the bench board, 2026-10-12: `systemd-networkd` removed both sets on its start and on a
 * link reconfiguration, and nothing put them back. The networkd drop-in (`planner.ts`) is what stops
 * that; this is what notices if anything else ever does it.
 *
 * Pure: no reading, no acting. The reading is `platform.net.rules()`, the acting is the reconciler's.
 */
import { CORE_ROUTE_TABLE, DEVICE_MARK_RULE_PRIORITY } from '@wayfarer/schemas';
import type { PolicyRule } from '../platform/parse/ip-json.ts';

/** One rule of the device's own bypass, in the terms both the unit and the check need. */
export interface BypassRule {
  priority: number;
  /** The selector as `ip rule add` takes it, without the priority and the table. */
  selector: string;
  matches: (rule: PolicyRule) => boolean;
}

/**
 * The bypass rules for these time ports. One list, read by the unit that installs the rules and by the
 * check that looks for them, so the two cannot describe different rules.
 */
export function deviceBypassRules(timePorts: number[]): BypassRule[] {
  const ownedByLoopback = (rule: PolicyRule): boolean => !rule.inverted && rule.iif === 'lo' && rule.table === 'main';
  return [
    {
      priority: DEVICE_MARK_RULE_PRIORITY,
      selector: 'uidrange 0-0 iif lo',
      matches: (rule) => ownedByLoopback(rule) && rule.uidStart === 0 && rule.uidEnd === 0,
    },
    ...timePorts.flatMap((port, index) =>
      (['udp', 'tcp'] as const).map((protocol, offset) => ({
        priority: DEVICE_MARK_RULE_PRIORITY + 1 + index * 2 + offset,
        selector: `ipproto ${protocol} dport ${port} iif lo`,
        matches: (rule: PolicyRule) => ownedByLoopback(rule) && rule.ipproto === protocol && rule.dport === port,
      })),
    ),
  ];
}

export interface PolicyRuleReading {
  /** Priorities of bypass rules that are absent. Empty when all are there. */
  missingBypass: number[];
  /** The core is running and none of its rules are present. */
  coreCaptureMissing: boolean;
}

export function readPolicyRules(input: {
  rules: PolicyRule[];
  timePorts: number[];
  /** Whether the core's rules are expected: it is part of the plan and its unit is active. */
  coreActive: boolean;
}): PolicyRuleReading {
  const missingBypass = deviceBypassRules(input.timePorts)
    .filter((expected) => !input.rules.some((rule) => rule.priority === expected.priority && expected.matches(rule)))
    .map((expected) => expected.priority);
  const coreCaptureMissing =
    input.coreActive && !input.rules.some((rule) => rule.table === String(CORE_ROUTE_TABLE));
  return { missingBypass, coreCaptureMissing };
}

/** For a person reading `/api/observers` or the event log. */
export function describePolicyRules(reading: PolicyRuleReading): string {
  const parts: string[] = [];
  if (reading.missingBypass.length > 0) {
    parts.push(`the device's own bypass is missing (${reading.missingBypass.join(', ')})`);
  }
  if (reading.coreCaptureMissing) parts.push(`the core's capture rules (table ${String(CORE_ROUTE_TABLE)}) are missing`);
  return parts.length === 0 ? 'all policy rules present' : parts.join('; ');
}
