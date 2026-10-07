/**
 * Plans against a real inventory captured from a device, and writes the generated artefacts to a
 * directory so they can be validated by the real tools.
 *
 * Not a test: a harness for the one thing a fixture cannot answer — whether what this planner emits
 * is accepted by `nft -c -f` and by the proxy core's own `check`. Those two validators are the
 * arbiters, and they run on the device.
 *
 *   node --experimental-strip-types test/board-plan.mjs <inventory.json> <output-directory>
 *
 * Nothing here touches the device. The output directory is a scratch prefix; the reconciler is not
 * involved, so no unit is started, enabled or stopped.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { emptyProfile } from '@wayfarer/schemas';
import { plan } from '../src/core/planner.ts';
import { diff } from '../src/core/differ.ts';
import { emitTunnels } from '../src/core/emit.ts';
import { buildRegistry, coreCapabilitiesOf } from '../src/core/providers.ts';
import { parseForeignSchema } from '@wayfarer/protocols';

const [, , inventoryPath, outputDirectory, coreSchemaPath] = process.argv;
if (!inventoryPath || !outputDirectory) {
  console.error('usage: board-plan.mjs <inventory.json> <output-directory> [core-schema.json]');
  process.exit(2);
}

const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));

/**
 * A profile that exercises every generator against this hardware.
 *
 * The access point goes on whichever radio the driver says can host one, and the Wi-Fi client on a
 * *different* radio when there is one — chosen from the inventory rather than written down, because a
 * profile naming a radio would only be valid on the board it was written for.
 */
const apRadio = inventory.radios.find((radio) => radio.derived.canHostAccessPoint.value);
const clientRadio = inventory.radios.find(
  (radio) => radio !== apRadio && radio.derived.canHostClient.value,
);
const ethernet = inventory.interfaces.find(
  (entry) => entry.phy === null && entry.name !== 'lo' && entry.kind === null && entry.linkType === 'ether',
);

const bindFor = (radio) => {
  if (radio === undefined) return null;
  if (radio.reported.bus === 'usb' && radio.reported.usbId !== null) {
    return { by: 'phy-usb', value: radio.reported.usbId };
  }
  if (radio.reported.bus === 'platform' || radio.reported.bus === 'pci') return { by: 'phy-builtin' };
  return radio.reported.devicePath ? { by: 'bus-path', value: radio.reported.devicePath } : null;
};

const apBind = bindFor(apRadio);
if (apBind === null) {
  console.error('this inventory reports no radio that can host an access point');
  process.exit(1);
}

// A channel the driver actually offers on this radio, in the band it offers it in. Chosen rather than
// written, for the same reason the radio is.
const usable = apRadio.derived.channels.find(
  (channel) => !channel.disabled && !channel.noInitiatingRadiation && !channel.requiresRadarDetection,
);

const base = emptyProfile({ name: 'Bench verification', now: () => '2026-09-19T12:00:00.000Z' });

const profile = {
  ...base,
  accessPoint: {
    bind: apBind,
    radio: {
      band: usable?.band ?? '2.4GHz',
      channel: usable?.channel ?? 1,
      width: 20,
      country: apRadio.reported.regulatory.country ?? '00',
      hidden: false,
    },
    ssid: 'WayfarerBench',
    passphrase: { $secret: 'bench-verification-passphrase' },
    // The dual-role acknowledgement, set when this radio would need it. The planner refuses without
    // it, which is the behaviour being exercised.
    acceptChannelFollowsUplink: true,
  },
  uplinks: [
    ...(ethernet
      ? [
          {
            id: 'wan-eth',
            kind: 'ethernet',
            priority: 10,
            enabled: true,
            bind: { by: 'any-ethernet' },
            config: { dhcp: true },
          },
        ]
      : []),
    ...(clientRadio && bindFor(clientRadio)
      ? [
          {
            id: 'wan-wifi',
            kind: 'wifi-sta',
            priority: 20,
            enabled: true,
            bind: bindFor(clientRadio),
            config: { ssid: 'UpstreamNetwork', psk: { $secret: 'upstream-passphrase' } },
          },
        ]
      : []),
  ],
  tunnels: [
    {
      id: 'alt-a',
      name: 'Alternative A',
      role: 'alternative',
      enabled: true,
      protocol: 'vless',
      config: {
        server: '198.51.100.7',
        port: 443,
        id: { $secret: '00000000-0000-4000-8000-000000000000' },
        network: 'tcp',
        security: 'tls',
        serverName: 'example.invalid',
      },
    },
    {
      id: 'res-hq',
      name: 'Resource',
      role: 'resource',
      enabled: true,
      protocol: 'openvpn',
      config: { profile: { $secret: 'client\nremote 198.51.100.9 1194 udp\n' }, interfaceSuffix: 'hq' },
      resources: { domainSuffix: ['.hq.invalid'], ipCidr: ['10.0.0.0/8'] },
      dns: { server: '10.184.100.5', dynamic: true, domainSuffix: ['.hq.invalid'] },
    },
  ],
  policy: { ...base.policy, priority: ['alt-a'] },
  routing: {
    rules: [
      { kind: 'protect-own-networks' },
      { kind: 'tunnel-resources' },
      { kind: 'domain', domains: ['exact.invalid'], action: { outbound: 'direct' } },
      { kind: 'domainSuffix', suffixes: ['.internal.invalid'], action: { outbound: 'res-hq' } },
      { kind: 'ipCidr', cidrs: ['203.0.113.0/24'], action: { outbound: 'block' } },
      { kind: 'private', action: { outbound: 'direct' } },
    ],
    ruleSets: [],
  },
  firewall: {
    killSwitch: true,
    ipv6: 'block',
    ntpBypass: true,
    blockedEndpoints: [{ ipCidr: '198.51.100.0/24', ports: [3478], protocol: 'udp', note: 'address discovery' }],
  },
};

let coreSchema = null;
if (coreSchemaPath) {
  coreSchema = parseForeignSchema(readFileSync(coreSchemaPath, 'utf8'));
}

const emitted = emitTunnels({
  profile,
  core: coreCapabilitiesOf(coreSchema),
  installed: new Set(inventory.binaries.filter((entry) => entry.present).map((entry) => entry.name)),
  allocatedPorts: new Set(),
});

const result = plan({
  profile,
  inventory,
  facts: {
    // Deliberately empty: this harness is about what the generators emit, and the ownership refusals
    // are covered by fixtures. A real apply on this device would find both of these non-empty.
    foreignCores: [],
    interfaceClaims: [],
    managementInterfaces: [],
    /*
     * Empty, and it had been **missing** — which threw rather than defaulting, so this harness had
     * not run since the field was added. Found while updating it for the catalogue. A harness that
     * nothing executes is a harness that stops matching the code it drives, exactly like a test
     * nothing reaches; noted rather than quietly repaired.
     */
    uplinkNetworks: [],
    binaries: inventory.binaries.map((entry) => ({
      name: entry.name,
      present: entry.present,
      version: entry.version,
    })),
  },
  emissions: emitted.emissions,
  ports: emitted.ports,
  refusals: emitted.refusals,
  carriers: emitted.carriers,
  managementPort: 8088,
  timePorts: [123],
  coreBinaryPath: inventory.binaries.find((entry) => entry.name === 'sing-box')?.path ?? null,
  upScriptPath: '/opt/wayfarer/bin/tunnel-up',
  wayBinary: '/usr/local/bin/way',
});

const classified = diff({
  desired: result.desired,
  reality: {
    files: [],
    units: [],
    interfaces: inventory.interfaces.map((entry) => ({ name: entry.name, mac: entry.mac })),
    managementInterfaces: [],
    sysctl: {},
  },
});

for (const file of [...result.desired.files, ...result.desired.networkFiles]) {
  // The scratch prefix: the generated path, under the output directory. Nothing is written to /etc.
  const target = join(outputDirectory, file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.content, { mode: file.mode });
}

writeFileSync(
  join(outputDirectory, 'plan.json'),
  `${JSON.stringify(
    {
      usable: result.usable,
      blastRadius: classified.blastRadius,
      findings: result.findings,
      notes: result.desired.notes,
      humanDiff: classified.humanDiff,
      bindings: [...result.bindings.entries()].map(([role, resolution]) => ({ role, ...resolution })),
      units: result.desired.units.map((unit) => unit.name),
      catalogue: buildRegistry({
        coreSchema,
        present: new Set(inventory.binaries.filter((entry) => entry.present).map((entry) => entry.name)),
      })
        .list()
        .map((entry) => ({
          id: entry.id,
          available: entry.availability.available,
          reason: entry.availability.reason ?? null,
        })),
      refusals: emitted.refusals,
      carriers: [...emitted.carriers.entries()].map(([id, carrier]) => ({ id, ...carrier })),
    },
    null,
    2,
  )}\n`,
);

console.log(`usable=${result.usable} blastRadius=${classified.blastRadius}`);
console.log(`findings=${result.findings.length} files=${result.desired.files.length + result.desired.networkFiles.length}`);
for (const finding of result.findings) console.log(`  [${finding.severity}] ${finding.code} ${finding.pointer}`);
