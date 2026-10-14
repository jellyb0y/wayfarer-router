/**
 * Asking one resolver for one name.
 *
 * Here because a query leaves the process for a socket, and only this layer knows a network exists. The
 * resolver is named by the caller rather than taken from the system configuration: the question is
 * always "does the resolver a client is handed answer", and the device's own resolver is a different
 * one (`/etc/resolv.conf` points at systemd-resolved, which clients never see).
 */

import { Resolver } from 'node:dns/promises';

export async function resolveWith(server: string, host: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  // One try: the caller retries on its own cadence, and the runtime's default of four tries with a
  // growing timeout would turn one failed check into twenty seconds.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([server]);
  try {
    const addresses = await resolver.resolve4(host);
    return addresses.length > 0
      ? { ok: true, detail: `${host} is ${addresses[0]!}` }
      : { ok: false, detail: 'the answer held no address' };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, detail: typeof code === 'string' ? code : String(error) };
  } finally {
    resolver.cancel();
  }
}
