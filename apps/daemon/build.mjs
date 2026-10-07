// Bundle the daemon and the CLI into single files.
//
// Output format is CJS on purpose. The dependency tree here includes packages that
// still ship CommonJS with conditional requires, and esbuild resolves those into a
// CJS bundle without the interop shims an ESM bundle needs. The cost is no
// top-level await, which is why both entry points call an async main().
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const common = {
  bundle: true,
  platform: 'node',
  // The runtime installed on the device; see docs/09-stack.md.
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // node:sqlite and the rest of the built-ins are resolved by the runtime.
  external: ['node:*'],
  define: { 'process.env.NODE_ENV': '"production"' },
};

mkdirSync('dist', { recursive: true });

const results = await Promise.all([
  build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/daemon.cjs' }),
  build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/way.cjs' }),
]);

if (results.some((r) => r.errors.length > 0)) process.exit(1);

// A build stamp the daemon reports through GET /api/system, so a board can be told
// apart from the bundle someone thinks is on it.
writeFileSync(
  'dist/build.json',
  JSON.stringify({ builtAt: new Date().toISOString(), node: process.version }, null, 2) + '\n',
);
