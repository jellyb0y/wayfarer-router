/**
 * The update bundle: what it is, how it is signed, and how a device decides to trust one.
 *
 * ## Why a signature, and why this one
 *
 * An update through the API replaces the code this device runs as root. Before 2026-10-14 the only way to
 * do it was ssh and `deploy.sh`, which is what the owner asked to be rid of; a route that accepted any
 * upload would turn whoever holds an admin session into whoever decides what the device runs. So a bundle
 * is accepted only when it carries an Ed25519 signature that verifies against the public key installed on
 * the device (`updateKeyPath`), and the private half never leaves the machine the bundle is built on.
 *
 * Nothing is downloaded: `docs/11-deployment.md` still holds — the device does not fetch its own
 * replacement. A person uploads a file they built; the signature is what proves it was built by the key
 * holder, independently of the session that uploaded it, and with no clock involved (this board has none
 * it can trust at boot, which is the reason a certificate-based scheme was refused).
 *
 * ## The format
 *
 * One JSON document, so neither side needs an archiver:
 *
 * ```
 * { "format": "wayfarer-bundle/1", "manifest": "<JSON text>", "signature": "<base64>", "files": { "<path>": "<base64>" } }
 * ```
 *
 * The signature covers the manifest **text** exactly as carried, so there is no canonical-JSON question to
 * get wrong; the manifest lists every file with its SHA-256, so the signature covers the files through it.
 * A file not in the manifest, a manifest entry with no file, a path outside the bundle's own tree or a
 * hash that differs refuses the whole bundle.
 *
 * Pure: bytes in, verdict out. Writing what it holds is the installer's (`core/update.ts`).
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const BUNDLE_FORMAT = 'wayfarer-bundle/1';

/** The paths a bundle may carry, relative to the install directory. Anything else is refused by name. */
const ALLOWED = [/^daemon\.cjs$/, /^way\.cjs$/, /^build\.json$/, /^bin\/[A-Za-z0-9._-]+$/, /^ui\/[A-Za-z0-9._/-]+$/];
/** Required, or the bundle cannot run: an update without the daemon is not an update. */
const REQUIRED = ['daemon.cjs', 'way.cjs', 'build.json'];

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: string;
  builtAt: string;
  files: { path: string; sha256: string; bytes: number; mode: number }[];
}

export interface VerifiedBundle {
  manifest: BundleManifest;
  files: Map<string, Buffer>;
}

export type BundleVerdict = { ok: true; bundle: VerifiedBundle } | { ok: false; reason: string };

export function verifyBundle(bytes: Buffer, publicKeyPem: string): BundleVerdict {
  let envelope: { format?: unknown; manifest?: unknown; signature?: unknown; files?: unknown };
  try {
    envelope = JSON.parse(bytes.toString('utf8')) as typeof envelope;
  } catch {
    return { ok: false, reason: 'this is not a bundle: it does not parse as one' };
  }
  if (envelope.format !== BUNDLE_FORMAT) return { ok: false, reason: `this is not a ${BUNDLE_FORMAT} bundle` };
  if (typeof envelope.manifest !== 'string' || typeof envelope.signature !== 'string') {
    return { ok: false, reason: 'the bundle has no manifest or no signature' };
  }

  // The signature first, before anything the manifest says is believed.
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: 'the signing key installed on this device cannot be read' };
  }
  const signed = verify(null, Buffer.from(envelope.manifest, 'utf8'), key, Buffer.from(envelope.signature, 'base64'));
  if (!signed) return { ok: false, reason: 'the signature does not verify against the key installed on this device' };

  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(envelope.manifest) as BundleManifest;
  } catch {
    return { ok: false, reason: 'the signed manifest does not parse' };
  }
  if (manifest.format !== BUNDLE_FORMAT || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) {
    return { ok: false, reason: 'the signed manifest is not one this device reads' };
  }

  const carried = (typeof envelope.files === 'object' && envelope.files !== null ? envelope.files : {}) as Record<string, unknown>;
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const path of Object.keys(carried)) {
    if (!listed.has(path)) return { ok: false, reason: `the bundle carries ${path}, which its signed manifest does not list` };
  }
  for (const path of REQUIRED) {
    if (!listed.has(path)) return { ok: false, reason: `the bundle has no ${path}` };
  }

  const files = new Map<string, Buffer>();
  for (const entry of manifest.files) {
    if (!ALLOWED.some((pattern) => pattern.test(entry.path)) || entry.path.split('/').includes('..')) {
      return { ok: false, reason: `the bundle names ${entry.path}, which is outside what an update may replace` };
    }
    const content = carried[entry.path];
    if (typeof content !== 'string') return { ok: false, reason: `the manifest lists ${entry.path} and the bundle does not carry it` };
    const data = Buffer.from(content, 'base64');
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) {
      return { ok: false, reason: `${entry.path} is not the file the signed manifest describes` };
    }
    files.set(entry.path, data);
  }
  return { ok: true, bundle: { manifest, files } };
}

/** Builds a bundle. Used by `scripts/bundle.mjs` and by the tests; never on the device. */
export function signBundle(input: { version: string; builtAt: string; files: Map<string, { data: Buffer; mode: number }>; privateKeyPem: string }): Buffer {
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: input.version,
    builtAt: input.builtAt,
    files: [...input.files].map(([path, file]) => ({
      path,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      bytes: file.data.byteLength,
      mode: file.mode,
    })),
  };
  const text = JSON.stringify(manifest);
  const signature = sign(null, Buffer.from(text, 'utf8'), createPrivateKey(input.privateKeyPem)).toString('base64');
  const files = Object.fromEntries([...input.files].map(([path, file]) => [path, file.data.toString('base64')]));
  return Buffer.from(JSON.stringify({ format: BUNDLE_FORMAT, manifest: text, signature, files }));
}
