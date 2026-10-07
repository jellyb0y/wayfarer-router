#!/usr/bin/env python3
"""
Does the STUN block actually stop a client discovering a public address?

Run this from a machine on the router's network **with every VPN switched off**.
It refuses to report a verdict it cannot support: if the control servers do not
answer, the probe was not capable of passing, and a probe that cannot pass is not
evidence that a block works.

    python3 scripts/stun-check.py

Three things it establishes, in order, and it stops at the first that fails:

  1. The traffic really leaves through the router — not through a VPN on this
     machine. Measured from the routing table, not assumed.
  2. Names are resolved by the router, as a real client resolves them. A name
     resolved somewhere else and dialled as a literal address cannot be matched
     by a rule written about a name, so resolving locally would test nothing.
  3. Blocked servers stay silent while control servers answer.
"""
import os, re, socket, struct, subprocess, sys, time

BLOCKED = [('stun.l.google.com', 19302), ('stun1.l.google.com', 19302),
           ('stun2.l.google.com', 19302), ('stun.services.mozilla.com', 3478)]
CONTROL = [('stun.cloudflare.com', 3478), ('stun.nextcloud.com', 3478),
           ('stun.sipgate.net', 3478)]


def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ''


def own_address_and_router():
    """My address on a directly attached subnet, and the router on it."""
    for line in sh('netstat', '-rn', '-f', 'inet').splitlines():
        f = line.split()
        if len(f) >= 4 and f[0] == 'default':
            gw, dev = f[1], f[3]
            break
    else:
        return None, None, None
    if dev.startswith(('utun', 'tun', 'ppp', 'ipsec')):
        return None, gw, dev          # a VPN owns the default route
    addr = None
    out = sh('ifconfig', dev)
    m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', out)
    if m:
        addr = m.group(1)
    return addr, gw, dev


def stun(host, port, src, resolver, timeout=4.0):
    """One binding request. Returns (verdict, reflexive address or None)."""
    ip = resolve_via(host, resolver)
    if ip is None:
        return 'the router would not resolve the name', None
    tid = os.urandom(12)
    pkt = struct.pack('!HHI', 0x0001, 0, 0x2112A442) + tid
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.bind((src, 0))
        t0 = time.time()
        s.sendto(pkt, (ip, port))
        data, _ = s.recvfrom(2048)
    except socket.timeout:
        return 'silent', None
    except OSError as e:
        return f'could not send: {e}', None
    finally:
        s.close()
    ms = int((time.time() - t0) * 1000)
    return f'answered in {ms} ms', xor_mapped(data, tid)


def xor_mapped(data, tid):
    """The public address the server saw — what a detector actually reads."""
    if len(data) < 20:
        return None
    n = struct.unpack('!H', data[2:4])[0]
    i, end = 20, min(20 + n, len(data))
    while i + 4 <= end:
        t, l = struct.unpack('!HH', data[i:i + 4])
        v = data[i + 4:i + 4 + l]
        if t == 0x0020 and len(v) >= 8:          # XOR-MAPPED-ADDRESS
            port = struct.unpack('!H', v[2:4])[0] ^ 0x2112
            ip = bytes(b ^ m for b, m in zip(v[4:8], b'\x21\x12\xa4\x42'))
            return f'{socket.inet_ntoa(ip)}:{port}'
        i += 4 + l + (-l % 4)
    return None


def resolve_via(host, resolver):
    """Ask the router for the name, the way a client on its network does."""
    q = os.urandom(2) + b'\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00'
    for part in host.split('.'):
        q += bytes([len(part)]) + part.encode()
    q += b'\x00\x00\x01\x00\x01'
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(4)
    try:
        s.sendto(q, (resolver, 53))
        data, _ = s.recvfrom(2048)
    except Exception:
        return None
    finally:
        s.close()
    i = 12
    while i < len(data) and data[i]:
        i += data[i] + 1
    i += 5
    while i + 12 <= len(data):
        while i < len(data) and data[i] & 0xC0 != 0xC0 and data[i]:
            i += data[i] + 1
        i += 2 if i < len(data) and data[i] & 0xC0 == 0xC0 else 1
        if i + 10 > len(data):
            break
        t, _, _, dl = struct.unpack('!HHIH', data[i:i + 10])
        i += 10
        if t == 1 and dl == 4:
            return socket.inet_ntoa(data[i:i + 4])
        i += dl
    return None


def main():
    print('STUN block check\n' + '=' * 60)
    src, gw, dev = own_address_and_router()
    if src is None:
        print(f'\nSTOP. A VPN owns this machine\'s default route ({dev}, via {gw}).')
        print('Traffic would not go through the router, so nothing here would be')
        print('measuring the router. Switch the VPN off and run this again.')
        return 2
    print(f'\n1. Path: out through {dev} from {src}, router {gw} — no VPN in the way.')

    print(f'\n2. Names resolved by the router at {gw}:')
    probe = resolve_via('stun.l.google.com', gw)
    if probe is None:
        print('   STOP. The router did not answer a DNS query, so this test cannot')
        print('   behave like one of its clients. Nothing is concluded.')
        return 2
    print(f'   ok — stun.l.google.com -> {probe}')

    print('\n3. Control servers, which are NOT on the block list and MUST answer:')
    controls_ok = 0
    for host, port in CONTROL:
        verdict, seen = stun(host, port, src, gw)
        print(f'   {host:24s} {verdict}' + (f'   saw me as {seen}' if seen else ''))
        if 'answered' in verdict:
            controls_ok += 1
    if controls_ok == 0:
        print('\n   STOP. Not one control answered, so this probe was never able to')
        print('   pass. Silence from the blocked servers would prove nothing. Check')
        print('   that UDP leaves this network at all before reading anything else.')
        return 2

    print('\n4. Blocked servers, which MUST stay silent:')
    leaked = []
    for host, port in BLOCKED:
        verdict, seen = stun(host, port, src, gw)
        print(f'   {host:24s} {verdict}' + (f'   saw me as {seen}' if seen else ''))
        if 'answered' in verdict:
            leaked.append((host, seen))

    print('\n' + '=' * 60)
    if not leaked:
        print(f'WORKS. {controls_ok} control(s) answered, so the probe could pass;')
        print('every blocked server stayed silent. A browser asking one of these for')
        print('a public address gets nothing, which is what the detectors read.')
        return 0
    print(f'DOES NOT WORK. {len(leaked)} blocked server(s) answered:')
    for host, seen in leaked:
        print(f'   {host} reported this machine as {seen}')
    print('\nThe rule is written about a NAME and is applied by the proxy core to a')
    print('connection. STUN carries no name for the core to read, so unless the core')
    print('maps the DNS answer to the connection it has nothing to match on. The')
    print('address above is what a detector would publish.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
