/**
 * Detection of the binaries this device needs, and caching of the proxy core's own JSON
 * Schema.
 *
 * Cores are installed by the installer, never by the daemon: the API cannot fetch or run
 * executable code, so a compromised token cannot make the device download a binary.
 * Detection exists so the interface can say "this tunnel type needs a core that is not
 * installed, here is the command" instead of failing at apply time with something
 * cryptic.
 */

import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run } from './exec.ts';
import { readManaged, writeAtomic } from './files.ts';

export interface BinaryInfo {
  name: string;
  path: string;
  /** Version string as printed, and the parsed semantic part when there is one. */
  versionRaw: string;
  version: string | null;
  /**
   * Build tags or features the binary reports. For the proxy core these decide which
   * protocols exist at all, which is why protocol availability is discovered rather than
   * declared.
   */
  features: string[];
}

export interface BinaryDetector {
  detect(name: string): Promise<BinaryInfo | null>;
  /**
   * The proxy core's JSON Schema, fetched from the binary and cached per
   * `(version, build tags)`. Returns null when the core is absent or too old to emit it.
   */
  coreSchema(): Promise<{ schema: string; cacheKey: string; fromCache: boolean } | null>;
  /**
   * Runs the proxy core's own `check` against a generated configuration file.
   *
   * The binary, not the binary's schema. A schema describes the shape the core can *parse*; it does
   * not describe the configuration it will *accept*, and deprecations live only in the second set.
   * Measured: a generated configuration satisfied the emitted schema and every fixture, and the core
   * exited with FATAL on a DNS rule item deprecated two releases earlier.
   *
   * Returns null when no core is installed — a different answer from "the configuration is bad", and
   * the caller must not confuse them.
   */
  checkCoreConfig(configPath: string): Promise<{ ok: boolean; message: string } | null>;
}

/**
 * How each tool is asked for its version. Tools that only understand a bare `version` are listed
 * explicitly; everything else is asked with `--version` first.
 */
const VERSION_ARGUMENTS: Record<string, string[][]> = {
  'sing-box': [['version']],
  xray: [['version'], ['--version']],
  ip: [['-V']],
  iw: [['--version']],
};

/** Where a binary is looked for. PATH is not trusted: systemd units get a minimal one. */
const SEARCH_PATHS = ['/usr/bin', '/usr/sbin', '/usr/local/bin', '/usr/local/sbin', '/opt/bin'];

export interface DetectorOptions {
  /** Directory for the schema cache; on the device this is under /var/lib. */
  cacheDir: string;
  searchPaths?: string[];
  /** Name of the proxy core binary. Configuration, not a constant in the call sites. */
  coreBinary?: string;
}

export function createBinaryDetector(options: DetectorOptions): BinaryDetector {
  const searchPaths = options.searchPaths ?? SEARCH_PATHS;
  const coreBinary = options.coreBinary ?? 'sing-box';

  const find = async (name: string): Promise<string | null> => {
    for (const directory of searchPaths) {
      const candidate = join(directory, name);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        /* Next candidate. */
      }
    }
    return null;
  };

  const detect = async (name: string): Promise<BinaryInfo | null> => {
    const path = await find(name);
    if (path === null) return null;

    // `--version` first, and a bare `version` only for the tools that actually use that form.
    //
    // Measured on the bench board: probing with a bare `version` made dnsmasq log
    // "junk found in command line" followed by "FAILED to start up" to the journal, twice per
    // inventory read, attributed to *our* unit. Nothing was broken, but the journal said
    // otherwise — and a probe that manufactures failure messages is worse than no probe.
    //
    // The related landmine, avoided by never doing it: probing a daemon with an EMPTY argument
    // list. `dnsmasq` with no arguments does not print a version, it starts serving DNS.
    for (const args of VERSION_ARGUMENTS[name] ?? [['--version'], ['-v'], ['-V']]) {
      const result = await run(path, args, { timeoutMs: 5000 });
      const text = `${result.stdout}${result.stderr}`.trim();
      if (result.code === 0 && text !== '') {
        return {
          name,
          path,
          versionRaw: text,
          version: /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null,
          features: parseFeatures(text),
        };
      }
    }

    // Present but unwilling to identify itself. Reported as detected with no version,
    // because "installed but unknown version" is a different state from "missing" and the
    // interface needs to say so.
    return { name, path, versionRaw: '', version: null, features: [] };
  };

  return {
    detect,

    async checkCoreConfig(configPath) {
      const core = await detect(coreBinary);
      if (core === null) return null;
      const result = await run(core.path, ['check', '-c', configPath], { timeoutMs: 30_000 });
      return {
        ok: result.code === 0,
        // Verbatim: the core names the field and the reason, and paraphrasing loses both. It writes
        // its diagnosis to standard error, with warnings there too, so both streams are kept.
        message: `${result.stderr}${result.stdout}`.trim(),
      };
    },

    async coreSchema() {
      const core = await detect(coreBinary);
      if (core === null) return null;

      // Keyed by version *and* build tags: the same version compiled without QUIC emits a
      // different schema, and serving the wrong one would offer protocols the binary
      // cannot run.
      const key = createHash('sha256')
        .update(`${core.version ?? 'unknown'}\n${core.features.join(',')}`)
        .digest('hex')
        .slice(0, 16);
      const cachePath = join(options.cacheDir, `core-schema-${key}.json`);

      const cached = await readManaged(cachePath);
      if (cached !== null && cached.trim() !== '') {
        return { schema: cached, cacheKey: key, fromCache: true };
      }

      const result = await run(core.path, ['schema'], {
        timeoutMs: 20_000,
        maxOutputBytes: 8 * 1024 * 1024,
      });
      if (result.code !== 0 || result.stdout.trim() === '') return null;

      await mkdir(options.cacheDir, { recursive: true, mode: 0o750 });
      await writeAtomic(cachePath, result.stdout, { mode: 0o640 });
      return { schema: result.stdout, cacheKey: key, fromCache: false };
    },
  };
}

/**
 * Build tags, as the core prints them: a `Tags:` line of comma-separated names. Kept
 * verbatim so an unknown tag survives instead of being dropped by a whitelist.
 */
function parseFeatures(text: string): string[] {
  const tags = /^Tags:\s*(.+)$/m.exec(text);
  if (!tags) return [];
  return tags[1]!
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
