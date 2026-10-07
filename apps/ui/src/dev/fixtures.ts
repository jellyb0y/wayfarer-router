/**
 * The longest realistic value for every field, in one place.
 *
 * Every defect the owner reported is a length defect — text overflowing its container, text
 * wrapping where wrapping breaks meaning, a form that does not fit. **A form tested with short
 * values is a form tested with the wrong values**, and the short value is what a developer types
 * without thinking, so the wrong test is the default one.
 *
 * So these are not decorative. Each is the largest thing the schema or the world actually permits:
 *
 * * a 253-character domain — the maximum length of a DNS name;
 * * a full OpenVPN profile, inline certificate and key included;
 * * sixteen tunnels, which is the list length the bench board reaches;
 * * an interface flag list as the kernel prints it, which looks unbreakable to a layout engine;
 * * a 64-character profile name, which is the schema's own `maxLength`.
 *
 * They are exercised by the checks in `scripts/` at 360 px, where the failures are visible.
 */

/** 253 characters: the longest name DNS permits, in labels a real subdomain could have. */
export const LONGEST_DOMAIN = (() => {
  const label = 'a'.repeat(60);
  // Four 60-character labels and three dots is 243; pad the last label to reach exactly 253.
  const base = `${label}.${label}.${label}.${label}`;
  return `${base}${'b'.repeat(253 - base.length)}`;
})();

/** An IPv6 CIDR at the schema's 43-character ceiling. */
export const LONGEST_CIDR = '2001:0db8:85a3:0000:0000:8a2e:0370:7334/128';

/** The schema's `maxLength` for a profile or tunnel name. */
export const LONGEST_NAME = 'Amsterdam egress, evening failover, do not '.padEnd(64, 'x');

/**
 * A complete OpenVPN profile with inline credentials.
 *
 * This is the value that broke the panel: it is pasted whole, it is thousands of characters, it has
 * lines far wider than a phone, and it must be editable without the page scrolling sideways.
 */
export const OPENVPN_PROFILE = [
  'client',
  'dev tun',
  'proto udp',
  `remote ${LONGEST_DOMAIN} 1194`,
  'resolv-retry infinite',
  'nobind',
  'persist-key',
  'persist-tun',
  'remote-cert-tls server',
  'cipher AES-256-GCM',
  'auth SHA512',
  'verb 3',
  '<ca>',
  '-----BEGIN CERTIFICATE-----',
  ...Array.from({ length: 24 }, () => 'MIIFazCCA1OgAwIBAgIUBEVwsRx9SYYRnFwYd4Qm3nDNKK4wDQYJKoZIhvcNAQEL'),
  '-----END CERTIFICATE-----',
  '</ca>',
  '<cert>',
  '-----BEGIN CERTIFICATE-----',
  ...Array.from({ length: 20 }, () => 'MIIEpDCCAowCAQAwXjELMAkGA1UEBhMCTkwxFTATBgNVBAgMDE5vb3JkLUhvbGxh'),
  '-----END CERTIFICATE-----',
  '</cert>',
  '<key>',
  '-----BEGIN PRIVATE KEY-----',
  ...Array.from({ length: 26 }, () => 'MIIJQwIBADANBgkqhkiG9w0BAQEFAASCCS0wggkpAgEAAoICAQDCrVZKQmJrkzLm'),
  '-----END PRIVATE KEY-----',
  '</key>',
].join('\n');

/** A base64 key with no break opportunity anywhere in it. */
export const LONGEST_KEY = 'wG7Zq1vKX9mYbN4pRt2JhUdF6sLcA8eQ3iOxV5nM0kT=';

const FLAGS = ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP', 'NO-CARRIER', 'ALLMULTI', 'PROMISC', 'DYNAMIC'];

/** Sixteen tunnels: the list length the bench board reaches, each with a name at the ceiling. */
export const SIXTEEN_TUNNEL_NAMES = Array.from(
  { length: 16 },
  (_unused, index) => `${String(index + 1).padStart(2, '0')} ${LONGEST_NAME}`.slice(0, 64),
);

/** A status snapshot in which every string is as long as it can be. */
export function extremeStatus(): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    network: {
      links: ['wlan0-the-longest-interface-name', 'end0', 'wg-amsterdam-evening'].map((name) => ({
        name,
        operstate: name === 'end0' ? 'DOWN' : 'UP',
        flags: FLAGS,
      })),
    },
    units: Object.fromEntries(
      [
        'wayfarer-core.service',
        'wayfarer-hostapd.service',
        'wayfarer-openvpn-amsterdam-evening-failover.service',
        'wayfarer-cloak-amsterdam-evening-failover.service',
      ].map((unit, index) => [
        unit,
        {
          unit,
          activeState: index === 2 ? 'failed' : 'active',
          subState: index === 2 ? 'failed' : 'running',
          unitFileState: index === 3 ? 'disabled' : 'enabled',
          isActive: index !== 2,
          isEnabled: index !== 3,
          known: true,
        },
      ]),
    ),
    accessPoints: {
      'wlan0-the-longest-interface-name': {
        status: { state: 'ENABLED', channel: 149, frequencyMhz: 5745 },
        stations: Array.from({ length: 12 }, (_unused, index) => ({
          mac: `aa:bb:cc:dd:ee:${index.toString(16).padStart(2, '0')}`,
          signalDbm: -40 - index,
          connectedSeconds: 60 * index,
        })),
        /*
         * The worse of the two, because it is the one with something to say. The control socket
         * truncates its reply at about 4 KB, so a busy access point is exactly where the list comes
         * back short — and the sentence the screen then has to print is longer than any row on it.
         */
        stationsComplete: false,
        // The longest reason the daemon writes, so the sentence around it is measured at 320 px.
        stationsIncomplete: 'the full list was too long for one reply, and hostapd_cli list_sta did not answer in time',
      },
    },
    links: {
      'wlan1-client': {
        connected: true,
        ssid: 'A guest network with a deliberately very long broadcast name indeed',
        signalDbm: -67,
        txBitrate: { mbps: 433.3, mcs: 9, widthMhz: 80 },
      },
    },
    clock: { synchronized: false, ntpEnabled: true, at: new Date().toISOString() },
    // Arrivals and departures on the interface with the longest name, so the row carries both the
    // widest address column and the widest interface name at once.
    stationHistory: Array.from({ length: 8 }, (_unused, index) => ({
      accessPointInterface: 'wlan0-the-longest-interface-name',
      mac: `aa:bb:cc:dd:ee:${index.toString(16).padStart(2, '0')}`,
      action: index % 2 === 0 ? 'connected' : 'disconnected',
      at: new Date(Date.now() - index * 90_000).toISOString(),
    })),
  };
}

/**
 * A full event ring, with the longest summary any kind of event can produce.
 *
 * `count === capacity` on purpose: a full ring is the state in which the retention sentence has
 * something to warn about, and it is the state a device that has been running reaches.
 */
export function extremeEventLog(): Record<string, unknown> {
  const kinds = [
    'apply.started',
    'apply.succeeded',
    'apply.failed',
    'apply.reverted',
    'profile.activated',
    'tunnel.health',
    'safe-mode.entered',
    'auth.signin',
    'auth.lockout',
  ];
  return {
    source: 'eventlog',
    capacity: 5000,
    count: 5000,
    entries: Array.from({ length: 24 }, (_unused, index) => ({
      id: 5000 - index,
      // Spread across eleven days so the reach-back sentence has a span to report.
      at: new Date(Date.now() - index * 40_000_000).toISOString(),
      level: index % 7 === 0 ? 'error' : index % 3 === 0 ? 'warn' : 'info',
      kind: kinds[index % kinds.length]!,
      summary:
        index % 4 === 0
          ? `Apply refused: the tunnel "${LONGEST_NAME}" names a resource ${LONGEST_DOMAIN} that no rule set resolves`
          : `Tunnel ${LONGEST_NAME} changed health`,
      detail: null,
    })),
  };
}

/** A journal page whose lines are far wider than a phone, which is what a journal actually holds. */
export function extremeLogs(): Record<string, unknown> {
  return {
    source: 'journal',
    entries: Array.from({ length: 30 }, (_unused, index) => ({
      at: new Date(Date.now() - index * 1000).toISOString(),
      priority: index % 9 === 0 ? 3 : index % 5 === 0 ? 4 : 6,
      unit: 'wayfarer-openvpn-amsterdam-evening-failover.service',
      identifier: 'wayfarer-openvpn-amsterdam-evening-failover',
      message: `TLS handshake with ${LONGEST_DOMAIN}:1194 failed after 60 seconds (WARNING: no server certificate verification method has been enabled)`,
      bootId: 'c0ffee00c0ffee00c0ffee00c0ffee00',
    })),
    nextCursor: null,
    currentBootId: 'c0ffee00c0ffee00c0ffee00c0ffee00',
    containsEarlierBoots: true,
    hasMore: true,
    incomplete: true,
    incompleteReason: 'the read stopped at the size limit',
    currentBootEmpty: false,
  };
}

/** A capability report with a gap that has a command and a gap that has none. */
export function extremeCapabilities(): Record<string, unknown> {
  return {
    capabilities: [
      { id: 'ap', title: 'Host an access point', state: 'available', missing: [], remedies: [] },
      {
        id: 'obfuscation',
        title: 'Mask an OpenVPN tunnel',
        state: 'missing',
        missing: ['cloak-client'],
        remedies: [{ command: 'wayfarer install cloak-client --version 2.10.0 --from /media/usb/cloak' }],
      },
      {
        id: 'ap-and-client',
        title: 'Access point and uplink together',
        state: 'unknown',
        missing: ['a radio that reports its interface combinations'],
        remedies: [
          {
            command: null,
            note: `No radio was detected, so this cannot be answered. What each radio reports is on the Network screen; a radio that does not offer the AP mode cannot be made to by installing anything.`,
          },
        ],
        detail: 'No radios were detected.',
      },
    ],
    summary: { available: 1, missing: 1, unknown: 1 },
  };
}

/** A system reply whose every string is at its ceiling, including a missing binary and a warning. */
export function extremeSystem(): Record<string, unknown> {
  return {
    deviceId: 'd',
    deviceName: LONGEST_NAME,
    version: '0.9.0-rc.4+build.20260921.1330',
    buildAt: new Date().toISOString(),
    runtime: 'node v24.8.0 (single-file bundle, type stripping)',
    startedAt: new Date().toISOString(),
    uptimeSeconds: 987654,
    setupComplete: false,
    apiEnabled: true,
    schemaVersion: 7,
    /*
     * The bench board's own reading, 2026-09-21: the panel answered on loopback, on the access point
     * and on the wireless uplink `192.168.77.8`, and on nothing at the wire `192.168.77.7` — one
     * subnet, two interfaces, opposite answers. `tun0` is absent and must stay absent.
     */
    listen: {
      port: 8088,
      addresses: ['127.0.0.1', '10.44.0.1', '192.168.77.8'],
      unresolvedInterfaces: ['end0'],
    },
    clock: { timezone: 'Europe/Amsterdam', ntpEnabled: true, synchronized: false },
    binaries: [
      {
        name: 'sing-box',
        present: true,
        path: '/usr/local/lib/wayfarer/bin/sing-box-1.14.0-linux-arm64',
        version: '1.14.0',
        features: ['with_quic', 'with_grpc', 'with_wireguard', 'with_utls'],
        neededFor: 'the proxy core',
      },
      {
        name: 'cloak-client',
        present: false,
        path: null,
        version: null,
        features: [],
        neededFor: 'masking an OpenVPN tunnel so it is not recognised as one',
      },
    ],
    warnings: [
      'This board has no clock battery. While the clock is wrong, tunnels whose transport authenticates on a timestamp fail while direct connections work — which looks like broken tunnels and is a broken clock.',
    ],
  };
}

/**
 * The profile list at its longest: a 64-character name, a name that is also a URL, and a profile
 * that arrived from somebody else's redacted export with every credential missing.
 *
 * The third row is the one that matters. A list where nothing is missing never renders the pointers
 * a shared profile is short of — and those pointers are the longest strings on the screen.
 */
export function extremeProfiles(): Record<string, unknown> {
  const stamp = new Date().toISOString();
  return {
    activeProfileId: 'p1',
    profiles: [
      {
        id: 'p1',
        name: LONGEST_NAME,
        description: null,
        schemaVersion: 7,
        createdAt: stamp,
        updatedAt: stamp,
        active: true,
        missingSecrets: [],
      },
      {
        id: 'p2',
        // A name with no spaces in it, which is what a layout engine cannot break anywhere.
        name: 'amsterdam-evening-failover-with-cloak-and-subscription',
        description: 'Copied from the card that came back from the office, and never checked since.',
        schemaVersion: 7,
        createdAt: stamp,
        updatedAt: stamp,
        active: false,
        missingSecrets: [],
      },
      {
        id: 'p3',
        name: LONGEST_NAME.replace(/x+$/, 'shared'),
        description: null,
        schemaVersion: 6,
        createdAt: stamp,
        updatedAt: stamp,
        active: false,
        missingSecrets: [
          { pointer: '/accessPoint/passphrase', kind: 'psk' },
          { pointer: '/uplinks/0/config/psk', kind: 'psk' },
          { pointer: '/tunnels/0/config/credentials/password', kind: 'password' },
          { pointer: '/subscriptions/0/url', kind: 'subscription-url' },
        ],
      },
    ],
  };
}

/**
 * The aggregate view at its longest, with **all four reachability answers present**.
 *
 * A fixture holding only devices that answered would draw the fold at a fraction of its real width:
 * the widest strings on it are the two long refusals — "working but would not accept the token" and
 * "no answer, which may be the network between here and there" — and a peer's own `detail`, which is
 * an error string from a fetch and can be any length at all.
 */
export function extremeFleet(): Record<string, unknown> {
  return {
    devices: [
      {
        id: 'self',
        label: 'this device',
        baseUrl: '',
        state: 'self',
        deviceId: 'a3f1c9e77b2d4e8f',
        deviceName: LONGEST_NAME,
        version: '0.0.0+build.20260921.153044',
        uptimeSeconds: 934_212,
        activeProfile: LONGEST_NAME,
      },
      {
        id: 'peer-amsterdam',
        label: 'amsterdam',
        baseUrl: 'http://wayfarer-amsterdam-evening.internal.example.invalid:8088',
        state: 'answered',
        deviceId: 'a3f1c9e77b2d4e8f',
        deviceName: 'amsterdam-evening-failover',
        version: '0.0.0+build.20260920.221017',
        uptimeSeconds: 4_812,
        activeProfile: 'amsterdam-evening-failover-with-cloak',
      },
      {
        id: 'peer-refused',
        label: 'the office board',
        baseUrl: 'http://192.168.77.7:8088',
        state: 'refused',
        detail: 'HTTP 401: the stored token was rejected — it may have been revoked on that device.',
      },
      {
        id: 'peer-unreachable',
        label: 'the one in the cupboard',
        baseUrl: 'http://192.168.77.212:8088',
        state: 'unreachable',
        detail: 'fetch failed: connect ETIMEDOUT 192.168.77.212:8088 after 5000 ms',
      },
    ],
    // Two devices flashed from one card, which is the reading this notice exists for.
    duplicateIdentities: ['a3f1c9e77b2d4e8f'],
  };
}

/**
 * The hardware inventory, with the reading that made the Network screen necessary.
 *
 * `end0` at `192.168.77.7` and `wfwan0` at `192.168.77.8` — **one subnet, two interfaces** —
 * measured on the bench board on 2026-09-21, where the panel answered on the second and on nothing
 * at the first. A list of addresses cannot express that, which is why the screen prints names, and
 * a fixture without both of them cannot produce the failure the screen exists to prevent.
 *
 * `tun0` is here too and belongs to no profile this project created. The prohibition covers it
 * exactly the same, so the screen must never list it as a place the panel answers.
 */
export function extremeInventory(): Record<string, unknown> {
  const channels = [
    { band: '2.4 GHz', channel: 1, frequencyMhz: 2412, maxTxPowerDbm: 20, requiresRadarDetection: false, noInitiatingRadiation: false, disabled: false },
    { band: '5 GHz', channel: 52, frequencyMhz: 5260, maxTxPowerDbm: 23, requiresRadarDetection: true, noInitiatingRadiation: true, disabled: false },
    { band: '5 GHz', channel: 149, frequencyMhz: 5745, maxTxPowerDbm: 13, requiresRadarDetection: false, noInitiatingRadiation: false, disabled: false },
    { band: '5 GHz', channel: 165, frequencyMhz: 5825, maxTxPowerDbm: null, requiresRadarDetection: false, noInitiatingRadiation: false, disabled: true },
  ];

  return {
    at: new Date().toISOString(),
    system: { kernel: '6.12.47-current-sunxi64', architecture: 'aarch64', cpuCount: 4, memoryMb: 1024, boardModel: 'Orange Pi Zero3' },
    radios: [
      {
        phy: 'phy0',
        reported: {
          interfaceModes: ['IBSS', 'managed', 'AP', 'AP/VLAN', 'monitor', 'P2P-client', 'P2P-GO'],
          interfaceCombinations: [
            {
              // The driver's own words, and long enough to be the widest run of text on the screen.
              text: '#{ managed } <= 1, #{ AP } <= 1, total <= 2, #channels <= 1, STA/AP BI must match',
              total: 2,
              channels: 1,
            },
          ],
          bus: 'usb',
          usbId: '0bda:b812',
          macFromSysfs: '90:de:80:47:b4:b4',
          antennas: { txMask: 1, rxMask: 1 },
          maxAssociatedStations: 16,
          regulatory: { source: 'own', country: 'NL', dfsRegion: 'ETSI' },
          interfaces: [{ name: 'wlx90de8047b4b4', type: 'AP', channel: 149, widthMhz: 80, ssid: LONGEST_NAME }],
        },
        derived: {
          canHostAccessPoint: { value: true, from: 'iw phy reports the AP mode' },
          canHostClient: { value: true, from: 'iw phy reports the managed mode' },
          accessPointAndClientTogether: { value: { supported: true, sameChannelOnly: true }, from: '#channels <= 1' },
          removable: { value: true, from: 'the device sits on the USB bus' },
          scanAllowedNow: { value: false, from: 'an access point is running on this radio' },
          bands: { value: ['2.4 GHz', '5 GHz'], from: 'iw phy' },
          channels,
        },
      },
    ],
    interfaces: [
      { name: 'lo', operstate: 'UNKNOWN', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], mac: null, phy: null, wirelessType: null, addresses: [{ family: 'inet', address: '127.0.0.1', prefixLength: 8 }] },
      { name: 'end0', operstate: 'UP', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mac: '02:81:4f:2a:1b:0c', phy: null, wirelessType: null, addresses: [{ family: 'inet', address: '192.168.77.7', prefixLength: 24 }] },
      { name: 'wfwan0', operstate: 'UP', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mac: '90:de:80:47:b4:b5', phy: 'phy0', wirelessType: 'managed', addresses: [{ family: 'inet', address: '192.168.77.8', prefixLength: 24 }] },
      { name: 'wlx90de8047b4b4', operstate: 'UP', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'], mac: '90:de:80:47:b4:b4', phy: 'phy0', wirelessType: 'AP', addresses: [{ family: 'inet', address: '10.44.0.1', prefixLength: 24 }] },
      { name: 'tun0', operstate: 'UNKNOWN', flags: ['POINTOPOINT', 'MULTICAST', 'NOARP', 'UP', 'LOWER_UP'], mac: null, phy: null, wirelessType: null, addresses: [{ family: 'inet', address: '10.136.0.6', prefixLength: 24 }] },
    ],
    notes: [
      'This radio reports `#{managed, AP} <= 1` with `#channels <= 1`: an access point and a Wi-Fi uplink can run together only on one shared channel, so changing the access point channel moves the uplink with it.',
    ],
  };
}

/**
 * A profile document in the **new** tunnel shape: `protocol` from the catalogue plus a typed
 * configuration. There is no `provider`, no `transports`, no opaque `config` record, and no
 * `command`, `configFile` or `localPort` — the system knows how to start these.
 *
 * Sixteen tunnels, which is the list length the bench board reaches, each name at the schema's
 * 64-character ceiling. The Cloak entry carries four entry points, which is what the bench's own
 * obfuscated tunnel has.
 */
export function extremeProfileDocument(): Record<string, unknown> {
  const protocols = ['openvpn', 'cloak-openvpn', 'vless', 'proxy'] as const;

  return {
    meta: { name: LONGEST_NAME, schemaVersion: 7 },
    tunnels: SIXTEEN_TUNNEL_NAMES.map((name, index) => {
      const protocol = protocols[index % protocols.length]!;
      /*
       * **This tunnel's position among the tunnels of its own protocol**, and every special case
       * below is pinned to it rather than to an absolute index.
       *
       * `index === 3` and `index === 7` were correct only because `protocols.length === 4`. A fifth
       * catalogue entry would have moved every protocol along and silently stopped this bench from
       * ever rendering an HTTPS proxy — with the `protocol === 'proxy'` guard keeping `check:360`
       * green while the coverage dropped. That is the same shape as the Reality tunnel, which this
       * file had just been corrected for, reintroduced two screens down in the same commit.
       */
      const nth = Math.floor(index / protocols.length);
      const common = {
        id: `tunnel-${String(index + 1).padStart(2, '0')}`,
        name,
        // Every fifth rather than every fourth, so the role is **not** perfectly correlated with
        // the protocol: at `% protocols.length` every resource tunnel was an OpenVPN tunnel, and a
        // control that only appears for one combination of the two would have gone unmeasured.
        role: index % 5 === 0 ? 'resource' : 'alternative',
        // Not the tunnel that carries a special case below: the one disabled tunnel exists to
        // measure the disabled state, and pinning it to an index that another rule also claims makes
        // one fixture answer two questions and neither of them clearly.
        enabled: index !== 1,
        // The field that never had a control: what this tunnel exists to reach. Same words as a
        // routing rule, different pointer — which is how it stayed invisible.
        resources:
          index % 5 === 0
            ? { domainSuffix: [LONGEST_DOMAIN, 'internal.example'], ipCidr: [LONGEST_CIDR, '10.0.0.0/8'] }
            : undefined,
        /*
         * What happens to this tunnel's traffic when it cannot carry it. A control, so it must be here:
         * a control drawn against nothing is measured empty, and the bench reports that as ok. (What
         * was fetched through it to decide that — `probe` — left the profile on 2026-09-24.)
         */
        onUnavailable: index % 3 === 0 ? 'fall-through' : 'block',
        dns:
          index % 5 === 0
            ? { server: '10.0.0.53', dynamic: true, domainSuffix: [LONGEST_DOMAIN, 'internal.example'] }
            : undefined,
        // One tunnel that came from a subscription rather than from a person, so the row that says a
        // refresh will replace it is drawn and measured.
        derivedFrom:
          index === 2
            ? { subscription: 'subscription-01', node: `${LONGEST_DOMAIN}#${'n'.repeat(120)}` }
            : undefined,
      };
      if (protocol === 'openvpn') {
        return { ...common, protocol, config: { profile: OPENVPN_PROFILE, auth: { username: 'operator' } } };
      }
      if (protocol === 'cloak-openvpn') {
        return {
          ...common,
          protocol,
          config: {
            profile: OPENVPN_PROFILE,
            entryPoints: Array.from({ length: 4 }, (_unused, entry) => ({
              id: `entry-${entry + 1}`,
              name: `Entry point ${entry + 1}`,
              host: LONGEST_DOMAIN,
              port: 443,
              uid: { $set: true },
              publicKey: LONGEST_KEY,
              proxyMethod: 'openvpn',
              encryptionMethod: 'aes-256-gcm',
              serverName: LONGEST_DOMAIN,
              browserSignature: 'chrome',
              transport: 'direct',
            })),
          },
        };
      }
      /*
       * Proxies come in threes and the fixture has to hold more than one of them, because the two
       * TLS fields are rendered for `https` and for nothing else. A fixture where every proxy was
       * SOCKS would take `tlsServerName` and `tlsCertificate` out of the rendered DOM, out of the
       * coverage manifest and out of the 360 px measurement — silently, every check still green.
       * The same trap the Reality fields are held open against, one entry along.
       *
       * Every value invented. The certificate is a plausible-length PEM and decodes to nothing.
       */
      if (protocol === 'proxy') {
        // The first proxy is HTTPS, the second is HTTP and the rest are SOCKS — because SOCKS with
        // a user name and a password is the configuration this entry was written for.
        const https = nth === 0;
        return {
          ...common,
          protocol,
          config: {
            type: https ? 'https' : nth === 1 ? 'http' : 'socks',
            server: LONGEST_DOMAIN,
            port: https ? 8443 : 1080,
            // The measured shape this entry exists for: a SOCKS proxy with a user name and a
            // password. The password is held by the device, so the control renders behind Replace —
            // which is the state the harvest has to be able to see through.
            auth: { username: 'a'.repeat(128), password: { $set: true } },
            tlsServerName: https ? LONGEST_DOMAIN : undefined,
            tlsCertificate: https
              ? ['-----BEGIN CERTIFICATE-----', ...Array.from({ length: 8 }, () => 'M'.repeat(64)), '-----END CERTIFICATE-----']
              : undefined,
          },
        };
      }

      /*
       * One of the VLESS tunnels uses Reality, because its two fields are rendered only for that
       * choice. A fixture where every VLESS tunnel was TLS would take those two controls out of the
       * rendered DOM, out of the coverage manifest, and out of the 360 px measurement — silently, and
       * with every check still green.
       */
      /*
       * **The first VLESS tunnel**, and it must not be an absolute index.
       *
       * This was `index === 5`, which stopped being a VLESS tunnel the moment a fourth catalogue
       * entry was added: the protocols are dealt round, so every one of them moved. The Reality
       * branch simply stopped rendering, and the parity harvest is what said so —
       * `realityPublicKey` and `realityShortId` went from fillable to not — which is the whole
       * reason that check compares a rendered DOM rather than a list somebody keeps.
       *
       * It was then corrected to `index === 6`, which is the same defect with a different number.
       * Pinned to the ordinal within this protocol, it survives a fifth entry.
       */
      const reality = nth === 0;
      return {
        ...common,
        protocol,
        config: {
          server: LONGEST_DOMAIN,
          port: 443,
          id: { $set: true },
          network: reality ? 'tcp' : 'ws',
          security: reality ? 'reality' : 'tls',
          serverName: LONGEST_DOMAIN,
          path: reality ? undefined : `/${'p'.repeat(200)}`,
          flow: 'xtls-rprx-vision',
          fingerprint: 'chrome',
          alpn: ['h2', 'http/1.1'],
          host: LONGEST_DOMAIN,
          // Key material, and the field that decides which client carries this tunnel — never asked
          // about here, and 1.6 KiB of it on the bench board.
          encryption: { $set: true },
          realityPublicKey: reality ? LONGEST_KEY : undefined,
          realityShortId: reality ? '0123456789abcdef' : undefined,
        },
      };
    }),
    /*
     * The half of the document that had no controls until the old editor was deleted and these were
     * rebuilt onto Network and Settings. Every binding is deliberately one of the kinds that draws a
     * second field: `any-ethernet` and `phy-builtin` hide the identifier box, so a fixture using only
     * those would take `/accessPoint/bind/value` and `/uplinks/-/bind/value` out of the rendered DOM,
     * out of the manifest and out of the 360 px measurement — with every check still green.
     */
    network: {
      cidr: '10.44.0.1/24',
      dhcp: { enabled: true, from: '10.44.0.100', to: '10.44.0.200', leaseHours: 12 },
    },
    dns: {
      direct: '1.1.1.1',
      overTunnel: '10.0.0.53',
      strategy: 'prefer_ipv4',
      logQueries: true,
    },
    accessPoint: {
      // A network name at the ceiling a radio allows, which is shorter than a profile name's.
      ssid: LONGEST_NAME.slice(0, 32),
      passphrase: { $set: true },
      radio: { band: '5GHz', channel: 149, width: 80, country: 'GE', hidden: true },
      bind: { by: 'mac', value: '90:de:80:47:b4:b4' },
      acceptChannelFollowsUplink: true,
      /*
       * Both roles' `pinName` and `takeOverInterface` are here with a value, and deliberately not the
       * same value on every role: absent is what the schema's default means and a chosen `true` is
       * what an operator's answer looks like, and a fixture holding only one of them measures only one
       * of the two states the control can be in. The uplinks below carry the other combination.
       */
      pinName: true,
      takeOverInterface: true,
    },
    uplinks: [
      {
        id: 'wan-eth-0',
        kind: 'ethernet',
        priority: 10,
        enabled: true,
        bind: { by: 'bus-path', value: 'platform-ff540000.usb-usb-0:1.2:1.0' },
        // `pinName` and `takeOverInterface` unset: what a document written before those controls
        // existed looks like, which is the other half of the pair the Wi-Fi uplink below carries.
        /*
         * Addressed by hand, because `dhcp: true` is the branch that draws **nothing**. The address,
         * the gateway and the resolvers exist only for an uplink that is not learning them, so a
         * fixture with DHCP on every uplink takes three positions out of the rendered DOM, out of the
         * manifest and out of the 360 px measurement with every check green — the same shape as the
         * fixture that had no `ruleSet` rule. The values are the longest the schema permits: a full
         * IPv6 address with a prefix, and two resolvers of the same kind.
         */
        config: {
          dhcp: false,
          address: '2001:0db8:85a3:0000:0000:8a2e:0370:7334/128',
          gateway: '2001:0db8:85a3:0000:0000:8a2e:0370:7335',
          dns: ['2001:0db8:85a3:0000:0000:8a2e:0370:7353', '2606:4700:4700:0000:0000:0000:0000:1111'],
        },
      },
      {
        id: 'wan-wifi-0',
        kind: 'wifi-sta',
        priority: 20,
        enabled: true,
        bind: { by: 'phy-usb', value: 'usb-0:1.3:1.0' },
        pinName: true,
        takeOverInterface: true,
        /*
         * Every optional field set, for the same reason: `band`, `bssid` and `hidden` are absent from
         * a document written by anything before them, and absent renders as the default with nothing
         * to distinguish it from an answer somebody chose. The BSSID is the longest this field can
         * hold, which is also the value that has to survive beside its label at 360 px.
         */
        config: {
          ssid: LONGEST_NAME.slice(0, 32),
          psk: { $redacted: 'psk' },
          band: '5GHz',
          bssid: '90:de:80:47:b4:b4',
          hidden: true,
        },
      },
    ],

    /*
     * Two feeds, because the controls that edit one are drawn per feed and a document with none
     * renders the section's empty state — which fits inside 360 px, measures as ok, and would have
     * taken four pointers out of the coverage manifest without anything saying so. The first is the
     * one the third tunnel says it came from, so the count on the row is a real count.
     *
     * One has been read successfully and one has failed, because the row prints a different sentence
     * for each and the failure's detail is the longer of the two.
     */
    subscriptions: [
      {
        id: 'subscription-01',
        name: LONGEST_NAME,
        enabled: true,
        url: { $set: true },
        refreshHours: 24,
        lastRefresh: { at: '2026-09-21T09:14:02Z', ok: true, detail: '', nodeCount: 42 },
      },
      {
        id: 'subscription-02',
        name: LONGEST_NAME,
        enabled: false,
        url: { $redacted: 'subscription-url' },
        refreshHours: 0,
        lastRefresh: {
          at: '2026-09-21T09:14:02Z',
          ok: false,
          detail: 'the feed answered 403 and the body was not read, because a feed’s error text can echo the token back',
          nodeCount: 0,
        },
      },
    ],

    /*
     * The two fields the leak policy reads. They were absent from this document for as long as that
     * control lived on a screen the bench never mounted, and an absent `onAllDown` renders as the
     * default with nothing to distinguish it from a value somebody chose.
     */
    /*
     * The failover policy, whole. `onAllDown` was the only field here for as long as the leak-policy
     * control was the only thing reading this object; the eight thresholds and the three list fields
     * were reachable from the API alone.
     *
     * Both lists carry two entries rather than one, because a list of one cannot show a reader that
     * order is part of the answer, and the probe endpoints are the longest the schema permits — they
     * are URLs, which is the value class that breaks a layout.
     */
    policy: {
      onAllDown: 'direct',
      priority: ['tunnel-01', 'tunnel-02'],
      excluded: ['tunnel-03'],
      sticky: false,
      probes: {
        count: 4,
        maxFails: 2,
        maxLatencyMs: 500,
        maxJitterMs: 250,
        maxLossPercent: 34,
        failStreak: 2,
        intervalSeconds: 30,
        endpoints: [
          'http://connectivitycheck.gstatic.com/generate_204',
          `http://${LONGEST_DOMAIN}/generate_204`,
        ],
      },
    },
    // Deliberately the contradictory pair — a kill switch on, beside "keep passing traffic". It is the
    // combination that renders the longest paragraph on the screen, and the one the device refuses.
    /*
     * Two blocked endpoints, and deliberately not two of the same shape. Every field on an entry is
     * optional, so a list holding one entry of one shape leaves the rest of them out of the rendered
     * DOM — the `ruleSet` trap again, one object further down. The first is the address-and-ports
     * kind the firewall enforces; the second is the `domain` kind the **core** enforces, which does
     * nothing for a client that connects to a literal address, and the note says so in the document
     * as well as on the screen.
     */
    firewall: {
      killSwitch: true,
      ntpBypass: true,
      ipv6: 'block',
      blockedEndpoints: [
        {
          ipCidr: LONGEST_CIDR,
          ports: [3478, 5349, 19302, 19305],
          protocol: 'udp',
          note: 'Address-discovery servers: they answer with the address the packet arrived from.',
        },
        { domain: LONGEST_DOMAIN, protocol: 'any', note: 'Reachability probe.' },
      ],
    },
    routing: {
      rules: [
        { kind: 'protect-own-networks' },
        { kind: 'tunnel-resources' },
        { kind: 'domainSuffix', suffixes: [LONGEST_DOMAIN, 'example.test'], action: { outbound: 'tunnel-01' } },
        { kind: 'ipCidr', cidrs: [LONGEST_CIDR, '192.168.0.0/16'], action: { outbound: 'block' } },
        { kind: 'domain', domains: [LONGEST_DOMAIN], action: { outbound: 'direct' } },
        /*
         * The one kind whose control is drawn only for it. Without a `ruleSet` rule in this document
         * the list at `/routing/rules/-/sets` never renders, so it left the coverage manifest and the
         * 360 px measurement without anything saying so — the same shape as a fixture with no feeds
         * and no uplinks, one rule kind further down.
         */
        { kind: 'ruleSet', sets: ['ads', 'trackers'], action: { outbound: 'tunnel-01' } },
        { kind: 'private', action: { outbound: 'direct' } },
      ],
      /*
       * One fetched set and one on disk, because the two halves of `type` draw different fields: a
       * remote set has a URL and a refresh interval, a local one has a path, and a fixture holding
       * only one of them takes the other's controls out of the DOM with every check green. The URL
       * is the longest realistic one — a raw file on a hosting service, which is where these come
       * from and is also the value class that breaks a layout.
       */
      ruleSets: [
        {
          tag: 'ads',
          type: 'remote',
          url: `https://raw.githubusercontent.com/${LONGEST_NAME.replace(/[ ,]/g, '-')}/rule-sets/main/ads.srs`,
          format: 'binary',
          updateIntervalHours: 168,
        },
        { tag: 'trackers', type: 'local', path: '/etc/wayfarer/rule-sets/trackers.json', format: 'source' },
      ],
    },
    /*
     * The core's own control API. Absent from this document until now, which meant the position was
     * reachable from the API and from nothing else — and `enabled` defaults to true, so a blank
     * renders identically to a deliberate yes.
     */
    services: { clashApi: { enabled: true } },
  };
}

/**
 * The drift report, **which this bench answered with nothing until 2026-09-22.**
 *
 * `GET /api/drift` was added to the Status screen and no fixture was added here, so every request
 * for it landed on `window.__unanswered` and `check-360.mjs` had been failing on it since. The panel
 * it feeds was therefore never measured at any width — which is precisely the failure this bench was
 * built to catch, caught by the bench, about the bench.
 *
 * Every finding carries the longest realistic values, because the panel prints both sides of each
 * one and a row measured with short values is a row measured with the wrong values.
 */
/**
 * The observers, at their longest and in every state — added with the card on 2026-09-23, so the card
 * is measured at 360 px from the day it exists rather than from the day somebody notices it was not.
 */
export function extremeObservers(): Record<string, unknown> {
  const reading = (what: string, ageSeconds: number): Record<string, unknown> => ({
    at: '2026-09-23T03:04:05.000Z',
    ageSeconds,
    what,
  });
  return {
    problems: 3,
    observers: [
      {
        name: 'resolver-watch',
        watches: '/run/wayfarer/tunnel, where the tunnel up-script writes the resolver each peer pushed',
        everySeconds: null,
        state: 'not-running',
        problem:
          "resolver-watch is not running, so nothing is watching /run/wayfarer/tunnel: the watch could not be established and is retried every 30s: Error: ENOENT: no such file or directory, watch '/run/wayfarer/tunnel'",
        lastLooked: null,
        lastActed: null,
      },
      {
        name: 'resolver-follower',
        watches: `whether the core is configured with the resolver each tunnel's peer pushed`,
        everySeconds: 60,
        state: 'stale',
        problem: 'resolver-follower is supposed to look every 60s and has not looked for 612 min',
        lastLooked: reading(`not converged: "${LONGEST_DOMAIN}" captured 255.255.255.255 but the core is configured with 255.255.255.254`, 36_720),
        lastActed: reading('resolver.reconverge-deferred: transaction 2b7b61418065302e is awaiting-confirm', 36_730),
      },
      {
        name: 'tunnel-watchdog',
        watches: 'each tunnel’s health: to move traffic off a failing alternative, and to report whether each destination tunnel is alive',
        everySeconds: 30,
        state: 'failing',
        problem: `traffic for ${LONGEST_DOMAIN} is being refused: its selector is on block; partner (14 round(s)) reads dead; the guard does not block it, its traffic fails rather than leaving another way`,
        lastLooked: {
          ...reading(`no failover group; guards: ${LONGEST_DOMAIN} BLOCKED (not measured), partner DEAD 14 round(s) (gateway echo), hq not measurable (not measured), relay alive (traffic through it)`, 5),
          // Every tone, the longest note the observer keeps (400) and the longest action (300).
          items: [
            { subject: LONGEST_DOMAIN, state: 'BLOCKED', note: 'x'.repeat(400), method: 'not measured', action: 'y'.repeat(300), tone: 'bad' },
            {
              subject: 'partner',
              state: 'DEAD 14 round(s)',
              note: 'nothing has arrived from the peer for at least 420 s, and its keepalive sends something every 10–15 s (limit 60 s); 10.136.0.1, the gateway its peer pushed, over wfvpnprt answered earlier on this connection and has stopped (no echo reply)',
              method: 'gateway echo',
              action: 'its traffic is NOT being blocked by the guard: its outbound is bound to wfvpnprt, so while the tunnel is down its traffic fails with a connection error and cannot leave another way',
              tone: 'bad',
            },
            {
              subject: 'hq',
              state: 'not measurable',
              note: 'the time since the peer last sent anything is not known yet: this is the first reading of its counter; its peer has pushed no gateway since this device started, so there is nothing to echo',
              method: 'not measured',
              action: 'nothing: the guard reports and never blocks',
              tone: 'warn',
            },
            {
              subject: 'relay',
              state: 'alive',
              note: 'alive: 12 KB received through it in the last 30 s, so no check was sent',
              method: 'traffic through it',
              action: 'nothing: the guard reports and never blocks',
              tone: 'ok',
            },
          ],
        },
        lastActed: reading('guard.dead: partner reads dead; its traffic is NOT being blocked by the guard', 20),
      },
      {
        name: 'drift',
        watches: 'whether the files, units and kernel settings on this device match the stored profile',
        everySeconds: 900,
        state: 'ok',
        problem: null,
        lastLooked: reading(`this device is not running its stored profile: ${LONGEST_DOMAIN}`, 840),
        lastActed: reading('recorded config.diverged: the answer changed', 3_600),
      },
    ],
  };
}

export function extremeDrift(): Record<string, unknown> {
  return {
    report: {
      state: 'diverged',
      reason: 'every 15 minutes',
      findings: [
        {
          severity: 'error',
          code: 'config_diverged',
          kind: 'file-content',
          subject: '/etc/wayfarer/core/config.json',
          pointer: '/route/rules/7/domain_suffix/0',
          stored: LONGEST_DOMAIN,
          running: LONGEST_CIDR,
          message: `the generated core configuration differs from what the stored profile derives at ${LONGEST_DOMAIN}`,
          hint: 'Apply the active profile. Editing the generated file by hand puts it in force without recording it.',
        },
        {
          severity: 'error',
          code: 'config_diverged',
          kind: 'unit-stale',
          subject: 'wayfarer-openvpn-amsterdam-evening-failover.service',
          pointer: null,
          stored: 'running the configuration the stored profile derives',
          running: 'running an older configuration',
          message: 'the unit is running, but not from the configuration the stored profile derives',
          hint: 'Apply the active profile. Restarting the unit by hand puts the file in force without recording it.',
          becauseOf: ['/etc/wayfarer/generated/tunnels/amsterdam-evening-failover-01/openvpn.conf'],
        },
        /*
         * The rule-set finding, with the longest wording it can produce. It is here so the Status
         * panel is measured with it, and because it is the one finding on this list whose subject is
         * a word the owner typed rather than a path this device generated.
         */
        {
          severity: 'error',
          code: 'config_diverged',
          kind: 'rule-set-stale',
          subject: 'rule set "ads"',
          pointer: null,
          stored: 'refreshed every 168h',
          running:
            'at least 41d old — the cache holds every remote set together, so this figure only says ' +
            'something in it was refreshed then, and this set may be far older, which is already ' +
            'more than 3 refreshes of 168h missed in a row',
          message:
            'the routing sends traffic through rule set "ads", and this device’s copy of it is 41 days old. ' +
            'A list that is out of date does not know addresses allocated since it was written, so some of ' +
            'the traffic that rule was written for is leaving by the ordinary route while everything looks healthy',
          hint: 'Check this device’s uplink and the URL the set is fetched from: 3 refreshes in a row have not landed.',
        },
      ],
      checked: { files: 14, units: 21, sysctl: 6 },
      omitted: 0,
      at: '2026-09-22T09:14:03.117Z',
      durationMs: 412,
    },
    ageSeconds: 623,
    summary: '3 difference(s) between this device and its stored profile',
  };
}

/**
 * How old each rule set is, in the two states that print the most.
 *
 * `ads` is overdue and its figure is a **bound** — the core keeps every remote set in one cache file
 * this device does not read inside — so the sentence has to say so, and it is the longest one this
 * answer produces. `trackers` is a local set on a board whose clock has never been synchronised,
 * which is the state that must never render as a number: it is the one the owner's board is in every
 * time it boots without an uplink.
 */
export function extremeRuleSetAges(): Record<string, unknown> {
  return {
    // The bench's profile list makes `p1` the active one, and the Routing screen shows ages only
    // when the profile it is editing is the profile the answer is about.
    profileId: 'p1',
    sets: [
      {
        tag: 'ads',
        type: 'remote',
        state: 'overdue',
        ageSeconds: 3_542_400,
        intervalHours: 168,
        overdueAfterSeconds: 1_814_400,
        observedFrom: '/var/lib/wayfarer/core-cache.db',
        ageLabel: '41d',
        exact: false,
        summary:
          'at least 41d old — the cache holds every remote set together, so this figure only says ' +
          'something in it was refreshed then, and this set may be far older, which is already more ' +
          'than 3 refreshes of 168h missed in a row',
      },
      {
        tag: 'trackers',
        type: 'local',
        state: 'unmeasurable',
        ageSeconds: null,
        intervalHours: null,
        overdueAfterSeconds: null,
        observedFrom: '/etc/wayfarer/rule-sets/trackers.json',
        ageLabel: null,
        exact: true,
        summary: 'the clock has not been synchronised since boot, so its age cannot be measured',
      },
    ],
  };
}

/**
 * The plan and the apply at their worst, for the one surface a person reads under time pressure.
 *
 * `PlanReview` and `ConfirmationWindow` are not screens, so they fell through the words of E15 — "every
 * screen, every form" — and had never been measured at 360 px at all. They render only when a review or
 * an outcome exists, which on the bench is never.
 *
 * What makes them the *worst* case rather than one more case: every value on them is a path, a
 * pointer, a unit name or a reason written by the device, none of which a layout engine may break, and
 * they arrive in the moment the reader has the least attention to spare. A short sample would have
 * measured a comfortable page nobody will ever see.
 */
export function extremePlan(): Record<string, unknown> {
  const unit = 'wayfarer-tunnel-amsterdam-evening-failover-with-cloak@wlx90de8047b4b4.service';
  return {
    // The worst class, which is also the only one that draws the do-nothing notice above the button.
    blastRadius: 'network',
    usable: true,
    empty: false,
    humanDiff: [
      `rename end0 to wfwan0 — this interface carries the connection this page arrived over`,
      `write /etc/systemd/network/10-wayfarer-${'wlx90de8047b4b4'}.network — address the access point`,
      'write /etc/systemd/network/20-wayfarer-wfwan0.network — DHCP on the wireless uplink',
      'write /etc/hostapd/wayfarer-wlx90de8047b4b4.conf — the access point, channel 149, 80 MHz',
      'write /etc/wayfarer/generated/core/config.json — outbounds, rule sets and the routing table',
      ...Array.from({ length: 24 }, (_, index) =>
        `write /etc/wayfarer/generated/tunnels/amsterdam-evening-failover-${String(index).padStart(2, '0')}/openvpn.conf ` +
        '— the tunnel configuration, with its inline certificate and key',
      ),
      `restart ${unit} — its configuration changed`,
      'restart systemd-networkd.service — addressing changed on two interfaces',
      'reload nftables — the leak policy changed from fall-through to block',
    ],
    findings: [
      {
        severity: 'error',
        code: 'tunnel_resources_overlap_management',
        message:
          'The resource range 192.168.0.0/16 on tunnel “Amsterdam egress, evening failover” contains the ' +
          'address this page is being served on, 192.168.77.8.',
        hint:
          'Narrow the range to the networks the tunnel exists to reach, or move the protect anchor above ' +
          'this rule so the local and uplink networks go direct.',
        pointer: '/tunnels/0/resources/ipCidr/0',
      },
      {
        severity: 'warning',
        code: 'clock_not_synchronised',
        message: 'This board has no battery-backed clock and the time has not been synchronised since it started.',
        hint: 'Tunnels whose transport authenticates on a timestamp will fail while direct connections work.',
        pointer: '',
      },
    ],
    notes: [
      'This radio reports #{managed, AP} <= 1, so it can host the access point or join a network, never both at once.',
      'The proxy core on this device was built without the QUIC transport, so a tunnel configured for it is refused rather than started.',
    ],
    bindings: [
      {
        role: 'uplink-wifi',
        state: 'unbound',
        reason:
          'No interface here matches phy-usb 0e8d:7961. The profile was written on a device with a second ' +
          'USB radio, and nothing on this board claims that vendor and product.',
        candidates: [
          { label: 'wlx90de8047b4b4 — MediaTek MT7961, USB 0e8d:7961, currently hosting the access point' },
          { label: 'wlan0 — the built-in radio on the platform bus, in use as the uplink' },
        ],
      },
    ],
    files: [],
    units: [],
    fileChanges: [],
    unitChanges: [],
    sysctlChanges: [],
    interfaceRenames: [{ from: 'end0', to: 'wfwan0', carriesManagement: true }],
  };
}

/**
 * What came back from an apply that only half happened, with a window still open.
 *
 * Each refusal carries **its own** reason rather than sharing one sentence, because that is the shape
 * the reader has to compare: three things did not happen and each did not happen for a different
 * reason. A list with one shared explanation reads as one problem and measures a third as wide.
 */
export function extremeApply(): Record<string, unknown> {
  return {
    transaction: {
      id: 'b6f0c4a29d7e1835',
      state: 'awaiting-confirm',
      blastRadius: 'network',
      deadlineAt: new Date(Date.now() + 118_000).toISOString(),
      secondsRemaining: 118,
    },
    steps: [
      {
        step: 'rename end0 to wfwan0',
        ok: true,
        detail: 'the interface carrying this page was renamed; the address was kept',
        ms: 412,
      },
      {
        step: 'write /etc/wayfarer/generated/core/config.json',
        ok: true,
        detail: '24 outbounds, 2 rule sets, 19 routing rules',
        ms: 38,
      },
      {
        step: 'restart wayfarer-tunnel-amsterdam-evening-failover-with-cloak@wlx90de8047b4b4.service',
        ok: false,
        detail:
          'the unit started and exited within 200 ms: the client reported "Options error: Unrecognized ' +
          'option or missing or extra parameter(s) in [PUSH-OPTIONS]"',
        ms: 2_140,
      },
    ],
    refused: [
      {
        what: '/etc/systemd/network/10-wayfarer-wlx90de8047b4b4.network',
        blastRadius: 'network',
        needs: 'a confirmation window, because it changes the address this page is served on',
      },
      {
        what: 'rename wlan0 to wfap0',
        blastRadius: 'network',
        needs: 'the radio to be released by hostapd first, which this version does not do by itself',
      },
      {
        what: 'reload nftables',
        blastRadius: 'service',
        needs: 'the nft binary, which is not installed on this device',
      },
    ],
  };
}

/**
 * The transaction list, with one change inside its confirmation window.
 *
 * Added 2026-09-23 with the switch-off control, which reads this list for one thing: whether a window
 * is open. Open here on purpose — the blocked state carries the longest sentence the control has, with
 * a transaction id in it that a layout engine cannot break at a space, and a fixture with nothing open
 * would measure only the short one.
 */
export function extremeTransactions(): Record<string, unknown> {
  return {
    transactions: [
      { id: 'b6f0c4a29d7e1835', state: 'awaiting-confirm', blastRadius: 'network', secondsRemaining: 118 },
      { id: '9a1d7c3e5b20f468', state: 'committed', blastRadius: 'service', secondsRemaining: null },
    ],
  };
}

/**
 * The token list, at the lengths the schema allows.
 *
 * Added 2026-10-07 with the tokens card on Settings. A name at the 128-character ceiling with no space
 * to break at, every scope, and every date present — beside one with nothing used and nothing expiring,
 * which is the row whose "Never" values are shortest and would hide a field that has no room.
 */
export function extremeTokens(): Record<string, unknown>[] {
  return [
    {
      id: '1c76f2d90dacb27f',
      name: 'nightly-backup-of-every-profile-to-the-hq-nas-via-the-apply-scope-and-then-some-more-words-until-the-limit-of-the-field-is'.slice(0, 128),
      scopes: ['read', 'apply', 'admin'],
      createdAt: '2026-10-07T16:41:31.537Z',
      lastUsedAt: '2026-10-07T17:02:11.000Z',
      expiresAt: '2027-10-07T16:41:31.537Z',
    },
    { id: '9e2b7a6c1d0f4853', name: 'automation-token', scopes: ['read'], createdAt: '2026-10-07T16:41:31.537Z', lastUsedAt: null, expiresAt: null },
  ];
}

/**
 * The longest refusal the switch-off card prints, word for word as the route writes it.
 *
 * Not the window refusal, which is longer and which the card deliberately does not print: the first
 * version did, message and hint together, and this bench measured it at eight line boxes in 338 px —
 * a paragraph under a countdown. The card now answers that refusal with its blocked state instead.
 */
export const EXTREME_POWER_OFF_FAILURE =
  'Switching the device off needs an explicit confirmation in the request body. Nothing was done.';
