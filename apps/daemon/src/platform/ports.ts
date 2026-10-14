/**
 * A loopback port nothing is listening on, chosen by the kernel.
 *
 * For a process that runs for seconds beside the configured ones: asking the kernel for port 0 and
 * releasing it gives a number outside everything this daemon allocated, without reading what the running
 * plan holds. The window between releasing it and the child binding it is a race in principle; a
 * collision makes the child fail to start, which the caller reports as such.
 */

import { createServer } from 'node:net';

export async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('the kernel gave no port'))));
    });
  });
}
