/**
 * Every policy rule this device expects, for stand-in platforms that are not testing the rules.
 *
 * An apply that reconfigures a link now reads the policy rules afterwards and restarts units for any
 * that are missing (`core/reconciler.ts`, `reassertPolicyRules`). A stand-in that answered "none"
 * would make every such test about restarting the firewall; this one answers "all present".
 */
import { CORE_ROUTE_TABLE } from '@wayfarer/schemas';
import { deviceBypassRules } from '../../src/core/policy-rules.ts';
import type { PolicyRule } from '../../src/platform/parse/ip-json.ts';

export function allPolicyRules(timePorts: number[] = [123]): PolicyRule[] {
  const rule = (priority: number, extra: Partial<PolicyRule>): PolicyRule => ({
    priority, table: 'main', iif: 'lo', uidStart: null, uidEnd: null, ipproto: null, dport: null, inverted: false, ...extra,
  });
  return [
    ...deviceBypassRules(timePorts).map((bypass) => {
      const port = /dport (\d+)/.exec(bypass.selector);
      const protocol = /ipproto (\w+)/.exec(bypass.selector);
      return port === null
        ? rule(bypass.priority, { uidStart: 0, uidEnd: 0 })
        : rule(bypass.priority, { ipproto: protocol?.[1] ?? null, dport: Number(port[1]) });
    }),
    rule(9001, { table: String(CORE_ROUTE_TABLE), iif: null }),
  ];
}
