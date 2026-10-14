/**
 * Building and signing an update bundle, on the machine the code is built on.
 *
 *   node --experimental-strip-types scripts/bundle.ts keygen <directory>
 *   pnpm run build && WAYFARER_SIGNING_KEY=<private key> node --experimental-strip-types scripts/bundle.ts build [--out <file>]
 *
 * `keygen` writes `wayfarer-signing.key` (private, 0600 — it never goes to a device or into this
 * repository) and `wayfarer-signing.pub`, which is installed on each device once with
 * `deploy/install.sh --update-key <file>`. `build` packs what `deploy.sh` ships — the daemon and CLI
 * bundles, the build stamp, the interface and `deploy/bin/*` — into one signed file for
 * `POST /api/system/update` (the Software card on Settings).
 *
 * The format and the signature are `apps/daemon/src/core/update-bundle.ts`, imported rather than restated
 * here: a second copy of a format is two formats.
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signBundle } from '../apps/daemon/src/core/update-bundle.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`bundle: ${message}\n`);
  process.exit(1);
}

if (command === 'keygen') {
  const directory = args[0] ?? fail('keygen <directory>');
  if (directory.startsWith(REPO)) fail('the private key must not be written inside the repository');
  mkdirSync(directory, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyPath = join(directory, 'wayfarer-signing.key');
  if (existsSync(keyPath)) fail(`${keyPath} exists; a new key would make every device refuse what it signs`);
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeFileSync(join(directory, 'wayfarer-signing.pub'), publicKey);
  process.stdout.write(`wrote ${keyPath} (keep it) and ${join(directory, 'wayfarer-signing.pub')} (install on each device)\n`);
} else if (command === 'build') {
  const keyPath = process.env['WAYFARER_SIGNING_KEY'] ?? fail('set WAYFARER_SIGNING_KEY to the private key file');
  const files = new Map<string, { data: Buffer; mode: number }>();
  const add = (path: string, from: string, mode: number): void => {
    if (!existsSync(from)) fail(`${from} is missing; run pnpm run build first`);
    files.set(path, { data: readFileSync(from), mode });
  };
  const dist = join(REPO, 'apps/daemon/dist');
  add('daemon.cjs', join(dist, 'daemon.cjs'), 0o644);
  add('way.cjs', join(dist, 'way.cjs'), 0o644);
  add('build.json', join(dist, 'build.json'), 0o644);
  const walk = (base: string, prefix: string, mode: number): void => {
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) visit(full);
        else files.set(`${prefix}/${relative(base, full)}`, { data: readFileSync(full), mode });
      }
    };
    visit(base);
  };
  if (!existsSync(join(REPO, 'apps/ui/dist/index.html'))) fail('apps/ui/dist is missing; run pnpm run build first');
  walk(join(REPO, 'apps/ui/dist'), 'ui', 0o644);
  if (existsSync(join(REPO, 'deploy/bin'))) walk(join(REPO, 'deploy/bin'), 'bin', 0o755);

  const stamp = JSON.parse(files.get('build.json')!.data.toString('utf8')) as { version?: string; builtAt?: string };
  const version = stamp.version ?? fail('build.json has no version; rebuild with this tree');
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1]! : join(dist, `wayfarer-${version.replace(/[^A-Za-z0-9.+-]/g, '_')}.bundle`);
  const bundle = signBundle({ version, builtAt: stamp.builtAt ?? new Date().toISOString(), files, privateKeyPem: readFileSync(keyPath, 'utf8') });
  writeFileSync(out, bundle);
  process.stdout.write(`wrote ${out}: ${version}, ${String(files.size)} files, ${String(Math.round(bundle.byteLength / 1024))} KiB\n`);
} else {
  fail('keygen <directory> | build [--out <file>]');
}
