/**
 * A subscription served in **the proxy core's own JSON**: a whole client configuration, of which this
 * product keeps the nodes, the `selector`/`urltest` groups and the routing rules between them.
 *
 * Measured on 2026-11-07: the `za-stenoy.ru` feed answers `User-Agent: sing-box/…` with such a file —
 * 16 nodes, two selectors, four `urltest` groups, and rules sending UDP one way and everything else
 * another — and answers this product's own agent with two `vless://` links and none of that. See
 * docs/04-tunnels-and-protocols.md, "A feed in the proxy core's own format".
 *
 * ## Mirror the core, add nothing
 *
 * The owner's rule for this format: do what the core would do with the file. So every outbound becomes a
 * catalogue configuration field for field, every `selector`/`urltest` keeps its options in order and its
 * own parameters, and every rule keeps its place. What a client configuration carries for a phone —
 * inbounds, its own DNS, logging, a cache file — has no meaning on a router and is listed in `dropped`,
 * by name, rather than ignored.
 *
 * ## Refuse by position, never skip in silence
 *
 * An outbound the catalogue cannot hold, a rule this product cannot express, a reference to a tag that is
 * not there: each is a `failure` with a JSON Pointer into the feed. The rest still parses, as with a link
 * feed. A key nobody read is reported in the node's `ignoredParams`, for the reason that list exists: a
 * value dropped without a word is how a node ends up configured without something its server requires.
 *
 * Every value here is a credential or next to one. Nothing in this module logs.
 */

import { TUNNEL_CONFIGS, type Hysteria2Config, type VlessConfig } from '@wayfarer/schemas';
import type { JsonSchemaNode } from './json.ts';
import type { ParsedNode } from './subscriptions.ts';
import { createValidatorCache } from './validate.ts';

/** A reference inside the feed: an outbound's tag, or the core's built-in `direct`. */
export const DIRECT = 'direct';

export interface FeedSelector {
  tag: string;
  kind: 'selector' | 'urltest';
  /** Tags, in the feed's order, each a node, another selector, or `direct`. */
  options: string[];
  default?: string;
  url?: string;
  interval?: string;
  tolerance?: number;
  idleTimeout?: string;
  interruptExisting?: boolean;
}

export interface FeedRule {
  network?: 'tcp' | 'udp';
  port?: number[];
  privateDestination?: true;
  action: 'route' | 'reject';
  /** A tag or `direct`; absent for `reject`. */
  to?: string;
}

export interface FeedFailure {
  /** A JSON Pointer into the feed, so the report says which outbound or rule rather than "something". */
  at: string;
  reason: string;
}

export interface SingBoxFeed {
  /** One per outbound the catalogue holds. `label` is the tag; `identity` is `tag:<tag>`. */
  nodes: ParsedNode[];
  selectors: FeedSelector[];
  /** The tag `route.final` names: the selector that is the group itself. */
  final: string;
  rules: FeedRule[];
  failures: FeedFailure[];
  /** What the file carried and this product deliberately does not carry, by name. */
  dropped: string[];
}

/** Whether a body is a configuration in the core's JSON rather than a list of links. */
export function looksLikeSingBoxFeed(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isRecord(value) && Array.isArray(value['outbounds']);
  } catch {
    return false;
  }
}

/**
 * Parses a feed in the core's JSON. Throws only when the body is not such a file at all, or names no
 * group to be: everything below that is a reported failure and the rest still parses.
 */
export function parseSingBoxFeed(text: string): SingBoxFeed {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('the feed is not JSON, so it is not a configuration in the proxy core’s format');
  }
  if (!isRecord(document) || !Array.isArray(document['outbounds'])) {
    throw new Error('the feed is JSON without an "outbounds" list, so it is not a proxy core configuration');
  }

  const failures: FeedFailure[] = [];
  const dropped: string[] = [];
  for (const key of Object.keys(document)) {
    // A phone's half of the file. A router has its own inbounds, its own resolver and its own logs.
    if (key === 'inbounds' || key === 'dns' || key === 'log' || key === 'experimental' || key === 'ntp' || key === 'certificate') {
      dropped.push(key);
    } else if (key !== 'outbounds' && key !== 'route') {
      failures.push({ at: `/${key}`, reason: `the feed sets "${key}", which this product does not carry` });
    }
  }

  const nodes: ParsedNode[] = [];
  const selectors: FeedSelector[] = [];
  const known = new Set<string>([DIRECT]);

  (document['outbounds'] as unknown[]).forEach((raw, index) => {
    const at = `/outbounds/${String(index)}`;
    if (!isRecord(raw)) {
      failures.push({ at, reason: 'this outbound is not an object' });
      return;
    }
    const type = raw['type'];
    const tag = raw['tag'];
    if (typeof tag !== 'string' || tag === '') {
      failures.push({ at, reason: 'this outbound has no tag, so nothing can refer to it' });
      return;
    }
    // `direct` is the core's own, and so is ours: the generated configuration has one. The feed's adds nothing.
    if (type === 'direct' && tag === DIRECT) return;
    if (type === 'block') {
      failures.push({ at, reason: `"${tag}" is a block outbound; this product expresses refusal as a reject rule` });
      return;
    }
    try {
      if (type === 'selector' || type === 'urltest') {
        selectors.push(readSelector(raw, type));
        known.add(tag);
        return;
      }
      const node = type === 'vless' ? readVless(raw) : type === 'hysteria2' ? readHysteria2(raw) : null;
      if (node === null) {
        failures.push({ at, reason: `"${tag}" is a ${String(type)} outbound, which this product does not run` });
        return;
      }
      const fault = configFault(node);
      if (fault !== null) {
        failures.push({ at, reason: `"${tag}": ${fault}` });
        return;
      }
      nodes.push(node);
      known.add(tag);
    } catch (error) {
      failures.push({ at, reason: `"${tag}": ${error instanceof Error ? error.message : String(error)}` });
    }
  });

  /*
   * References are resolved after every outbound is read, because the feed lists selectors before the
   * nodes they name. An option that went missing — its outbound was refused above — is dropped from its
   * selector and said; a selector left with nothing is itself refused, and that can cascade upwards.
   */
  let changed = true;
  while (changed) {
    changed = false;
    for (const selector of [...selectors]) {
      const kept = selector.options.filter((option) => known.has(option));
      for (const option of selector.options.filter((entry) => !known.has(entry))) {
        failures.push({ at: `/outbounds/@${selector.tag}`, reason: `"${selector.tag}" offers "${option}", which is not an outbound this product runs; left out` });
      }
      selector.options = kept;
      if (selector.default !== undefined && !kept.includes(selector.default)) delete selector.default;
      if (kept.length === 0) {
        failures.push({ at: `/outbounds/@${selector.tag}`, reason: `"${selector.tag}" has no option left` });
        selectors.splice(selectors.indexOf(selector), 1);
        known.delete(selector.tag);
        changed = true;
      }
    }
  }

  const route = isRecord(document['route']) ? document['route'] : {};
  const final = route['final'];
  if (typeof final !== 'string' || !selectors.some((selector) => selector.tag === final)) {
    throw new Error(
      typeof final === 'string'
        ? `the feed's route.final is "${final}", which is not a selector or urltest this product could run, so there is no group to make of it`
        : 'the feed has no route.final, so there is no selector to make the group of',
    );
  }

  const rules: FeedRule[] = [];
  (Array.isArray(route['rules']) ? route['rules'] : []).forEach((raw: unknown, index: number) => {
    const at = `/route/rules/${String(index)}`;
    const outcome = readRule(raw);
    if (outcome.kind === 'device') {
      dropped.push(`route.rules[${String(index)}] (${outcome.what})`);
      return;
    }
    if (outcome.kind === 'refused') {
      failures.push({ at, reason: outcome.reason });
      return;
    }
    if (outcome.rule.to !== undefined && !known.has(outcome.rule.to)) {
      failures.push({ at, reason: `this rule sends traffic to "${outcome.rule.to}", which is not an outbound this product runs; left out` });
      return;
    }
    rules.push(outcome.rule);
  });
  for (const key of Object.keys(route)) {
    if (key === 'rules' || key === 'final') continue;
    // Both describe how a phone finds its way out; this device states its own in the generated file.
    if (key === 'auto_detect_interface' || key === 'default_domain_resolver' || key === 'default_interface' || key === 'default_mark') {
      dropped.push(`route.${key}`);
    } else {
      failures.push({ at: `/route/${key}`, reason: `the feed sets route.${key}, which this product does not carry` });
    }
  }

  return { nodes, selectors, final, rules, failures, dropped };
}

/* ── outbounds ───────────────────────────────────────────────────────────────────────────── */

function readSelector(raw: Record<string, unknown>, kind: 'selector' | 'urltest'): FeedSelector {
  const read = reader(raw);
  read('type');
  const tag = read('tag') as string;
  const options = read('outbounds');
  if (!Array.isArray(options) || options.length === 0 || options.some((entry) => typeof entry !== 'string')) {
    throw new Error('a selector needs a list of outbound tags');
  }
  const selector: FeedSelector = { tag, kind, options: [...(options as string[])] };
  const fallback = read('default');
  if (typeof fallback === 'string') selector.default = fallback;
  const interrupt = read('interrupt_exist_connections');
  if (typeof interrupt === 'boolean') selector.interruptExisting = interrupt;
  if (kind === 'urltest') {
    const url = read('url');
    const interval = read('interval');
    const tolerance = read('tolerance');
    const idle = read('idle_timeout');
    if (typeof url === 'string') selector.url = url;
    if (typeof interval === 'string') selector.interval = interval;
    if (typeof tolerance === 'number') selector.tolerance = tolerance;
    if (typeof idle === 'string') selector.idleTimeout = idle;
  }
  const unread = read.unread();
  if (unread.length > 0) throw new Error(`the ${kind} sets ${unread.join(', ')}, which this product does not carry`);
  return selector;
}

/** VLESS in the core's spelling, into `TUNNEL_CONFIGS.vless`. */
function readVless(raw: Record<string, unknown>): ParsedNode {
  const read = reader(raw);
  read('type');
  const tag = read('tag') as string;
  const config: Record<string, unknown> = {
    server: read('server'),
    port: read('server_port'),
    id: read('uuid'),
    network: 'tcp',
    security: 'none',
  };
  put(config, 'flow', read('flow'));

  const tls = read('tls');
  if (isRecord(tls) && tls['enabled'] === true) {
    const inner = reader(tls, 'tls.');
    inner('enabled');
    refuseInsecure(inner('insecure'));
    put(config, 'serverName', inner('server_name'));
    const alpn = inner('alpn');
    if (Array.isArray(alpn) && alpn.length > 0) config['alpn'] = alpn;
    const utls = inner('utls');
    if (isRecord(utls) && utls['enabled'] === true) {
      const u = reader(utls, 'tls.utls.');
      u('enabled');
      put(config, 'fingerprint', u('fingerprint'));
      read.carry(u.unread());
    }
    const reality = inner('reality');
    if (isRecord(reality) && reality['enabled'] === true) {
      const r = reader(reality, 'tls.reality.');
      r('enabled');
      config['security'] = 'reality';
      put(config, 'realityPublicKey', r('public_key'));
      put(config, 'realityShortId', r('short_id'));
      read.carry(r.unread());
    } else {
      config['security'] = 'tls';
    }
    read.carry(inner.unread());
  }

  const transport = read('transport');
  if (isRecord(transport)) {
    const t = reader(transport, 'transport.');
    const type = t('type');
    // Only the transports whose fields the catalogue holds and writes back the same way. gRPC's
    // `service_name` and HTTPUpgrade have no catalogue field, and a node without them would not connect.
    if (type !== 'ws' && type !== 'http' && type !== 'quic') {
      throw new Error(`the transport "${String(type)}" has no field in this product's VLESS entry (it carries ws, http and quic)`);
    }
    config['network'] = type;
    put(config, 'path', t('path'));
    const headers = t('headers');
    if (isRecord(headers) && typeof headers['Host'] === 'string') config['host'] = headers['Host'];
    read.carry(t.unread());
  }

  const node: ParsedNode = { scheme: 'sing-box', label: tag, identity: `tag:${tag}`, protocol: 'vless', config: config as VlessConfig };
  const ignored = read.unread();
  if (ignored.length > 0) node.ignoredParams = ignored;
  return node;
}

/** Hysteria 2 in the core's spelling, into `TUNNEL_CONFIGS.hysteria2`. */
function readHysteria2(raw: Record<string, unknown>): ParsedNode {
  const read = reader(raw);
  read('type');
  const tag = read('tag') as string;
  const config: Record<string, unknown> = { server: read('server'), port: read('server_port'), password: read('password') };
  const ports = read('server_ports');
  if (Array.isArray(ports) && ports.length > 0) config['serverPorts'] = ports;

  const obfs = read('obfs');
  if (isRecord(obfs)) {
    const o = reader(obfs, 'obfs.');
    const type = o('type');
    if (type !== 'salamander') throw new Error(`the obfuscation "${String(type)}" is not one the core implements (only salamander)`);
    config['obfsPassword'] = o('password');
    read.carry(o.unread());
  }

  const tls = read('tls');
  if (isRecord(tls)) {
    const inner = reader(tls, 'tls.');
    inner('enabled');
    put(config, 'serverName', inner('server_name'));
    const alpn = inner('alpn');
    if (Array.isArray(alpn) && alpn.length > 0) config['alpn'] = alpn;
    // The owner's ruling: a feed that states it is followed. See `Hysteria2Config.insecure`.
    if (inner('insecure') === true) config['insecure'] = true;
    read.carry(inner.unread());
  }

  const node: ParsedNode = { scheme: 'sing-box', label: tag, identity: `tag:${tag}`, protocol: 'hysteria2', config: config as Hysteria2Config };
  const ignored = read.unread();
  if (ignored.length > 0) node.ignoredParams = ignored;
  return node;
}

/** VLESS keeps the product's existing refusal: no feed has asked for it there, so nothing changed. */
function refuseInsecure(value: unknown): void {
  if (value === true) {
    throw new Error('a VLESS node with tls.insecure turns off checking the server, and this product has no such switch for VLESS');
  }
}

/* ── rules ───────────────────────────────────────────────────────────────────────────────── */

type RuleOutcome =
  | { kind: 'rule'; rule: FeedRule }
  | { kind: 'device'; what: string }
  | { kind: 'refused'; reason: string };

/**
 * One rule, in the subset this product carries: by `network`, by `port`, `ip_is_private`; to an outbound
 * or rejected. `sniff` and DNS hijacking are what this device's own generated configuration already does
 * for every client, so they are noted and not duplicated.
 */
function readRule(raw: unknown): RuleOutcome {
  if (!isRecord(raw)) return { kind: 'refused', reason: 'this rule is not an object' };
  const read = reader(raw);
  const action = read('action') ?? 'route';
  if (action === 'sniff') {
    if (read.unread().length === 0) return { kind: 'device', what: 'sniff, which this device does for every connection' };
  }
  if (action === 'hijack-dns') {
    const protocol = read('protocol');
    if (protocol === 'dns' && read.unread().length === 0) return { kind: 'device', what: 'DNS hijacking, which this device does itself' };
  }
  if (action !== 'route' && action !== 'reject') {
    return { kind: 'refused', reason: `this rule's action "${String(action)}" with these matches is not one this product carries` };
  }

  const rule: FeedRule = { action };
  const network = read('network');
  if (network !== undefined) {
    const value = Array.isArray(network) && network.length === 1 ? network[0] : network;
    if (value !== 'tcp' && value !== 'udp') return { kind: 'refused', reason: `this rule matches network ${JSON.stringify(network)}; this product carries tcp or udp` };
    rule.network = value;
  }
  const port = read('port');
  if (port !== undefined) {
    const values = Array.isArray(port) ? port : [port];
    if (values.length === 0 || values.some((entry) => !Number.isInteger(entry) || entry < 1 || entry > 65535)) {
      return { kind: 'refused', reason: `this rule matches port ${JSON.stringify(port)}, which is not a list of ports` };
    }
    rule.port = values as number[];
  }
  const privateDestination = read('ip_is_private');
  if (privateDestination !== undefined) {
    if (privateDestination !== true) return { kind: 'refused', reason: 'this rule sets ip_is_private to something other than true' };
    rule.privateDestination = true;
  }
  if (action === 'route') {
    const outbound = read('outbound');
    if (typeof outbound !== 'string') return { kind: 'refused', reason: 'this rule routes and names no outbound' };
    rule.to = outbound;
  }
  const unread = read.unread();
  if (unread.length > 0) return { kind: 'refused', reason: `this rule matches on ${unread.join(', ')}, which this product does not carry` };
  // A rule with no match at all is "everything", which is what route.final already says.
  if (rule.network === undefined && rule.port === undefined && rule.privateDestination === undefined) {
    return { kind: 'refused', reason: 'this rule matches everything, which is what route.final is for' };
  }
  return { kind: 'rule', rule };
}

/* ── shared pieces ───────────────────────────────────────────────────────────────────────── */

/**
 * Reads keys off an object and remembers which, so "ignored" means *nothing read it* — the same
 * definition the link parser uses, for the same reason: a list of known keys kept beside the code drifts.
 */
function reader(object: Record<string, unknown>, prefix = '') {
  const seen = new Set<string>();
  const carried: string[] = [];
  const read = (key: string): unknown => {
    seen.add(key);
    return object[key];
  };
  read.unread = (): string[] => [...Object.keys(object).filter((key) => !seen.has(key)).map((key) => `${prefix}${key}`), ...carried].sort();
  read.carry = (keys: string[]): void => {
    carried.push(...keys);
  };
  return read;
}

function put(config: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string' && value !== '') config[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VALIDATORS = createValidatorCache();

/** The first reason the catalogue entry would refuse this configuration, or null. */
function configFault(node: ParsedNode): string | null {
  const result = VALIDATORS.forSchema(`catalogue\u0000${node.protocol}`, () => TUNNEL_CONFIGS[node.protocol] as unknown as JsonSchemaNode)
    .validate(node.config as Record<string, unknown>);
  if (result.valid) return null;
  const issue = result.issues[0];
  if (issue === undefined) return 'this outbound produced a configuration this product cannot store';
  const where = issue.pointer === '' ? 'the configuration' : `"${issue.pointer.replace(/^\//, '')}"`;
  return `this outbound produced a configuration this product cannot store: ${where} ${issue.message}`;
}
