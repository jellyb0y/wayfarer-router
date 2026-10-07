/**
 * The coverage manifest on disk: read, compared, and written **only when writing cannot disarm the
 * comparison.**
 *
 * Nothing in the application imports this. It is the file half of `src/parity.test.tsx`, kept out of
 * that file so the property below can be asserted directly — twice in a row, which is the whole
 * point — instead of by running a suite inside a suite.
 *
 * ## The guard that disarmed itself on the second run
 *
 * The earlier shape was: write the harvest to `parity-manifest.json`, then compare it against what
 * had been read a moment before. The write was deliberate and its argument was good — the file on
 * disk is then always the truth about what the interface renders today, so the diff is in the
 * working tree with the pointers named rather than hidden behind a rerun.
 *
 * Measured, 2026-09-21, by deleting the `ssid` `TextField` from `components/ProfileFields.tsx`:
 *
 *   - run 1 — 2 failures, both naming `/uplinks/-/config/ssid`;
 *   - run 2, **with no code change at all** — 1 failure and 3 passing, because run 1 had already
 *     rewritten the file it compares against.
 *
 * For a *required* pointer the parity comparison still fails on every run, so the deletion above
 * stays red. For everything else — the eight container pointers, and every leaf marked `generated`,
 * `device`, `catalogue` or `subscription` — a deletion fails exactly once and is green forever
 * after. And on a fresh checkout in CI, with the rewritten file committed, it is green on the first
 * run. **A guard that rearms only when somebody remembers is not a guard.**
 *
 * ## So the harvest is written where it cannot answer its own question
 *
 * On a mismatch the manifest is left alone and the harvest goes to `parity-manifest.actual.json`
 * beside it. Every run then reproduces the failure, the diff is still a file diff — `git diff
 * --no-index` over the pair, which the failure message names — and accepting the change is an act
 * somebody performs rather than a side effect of having run the tests twice.
 *
 * `WAYFARER_ACCEPT_MANIFEST=1` performs that act. It exists so that accepting a legitimate change
 * never means opening the manifest in an editor: the file says it is derived and never edited by
 * hand, and a workflow that forces a hand edit is how that stops being true.
 *
 * An **absent** manifest is still written, and is still a failure. There is nothing to disarm — the
 * first run has no claim to compare against — and refusing to write it would leave the reader with a
 * failure and no way to see what was harvested.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface ManifestEntry {
  pointer: string;
  screen: string;
}

export interface Manifest {
  generatedBy: string;
  screens: string[];
  fields: ManifestEntry[];
}

export type ManifestVerdict =
  | { status: 'unchanged' }
  | { status: 'absent'; wrote: string }
  | { status: 'changed'; wrote: string; gone: string[]; added: string[] };

/** The sibling the harvest goes to when it disagrees with the committed file. */
export function actualPath(manifestPath: string): string {
  return manifestPath.replace(/\.json$/, '.actual.json');
}

const key = (entry: ManifestEntry): string => `${entry.pointer} (${entry.screen})`;

export function compareManifest(
  manifestPath: string,
  harvested: Manifest,
  accept = process.env['WAYFARER_ACCEPT_MANIFEST'] === '1',
): ManifestVerdict {
  const rendered = `${JSON.stringify(harvested, null, 2)}\n`;

  let previous: string | null = null;
  try {
    previous = readFileSync(manifestPath, 'utf8');
  } catch {
    previous = null;
  }

  if (previous === null) {
    writeFileSync(manifestPath, rendered, 'utf8');
    return { status: 'absent', wrote: manifestPath };
  }
  if (previous === rendered) return { status: 'unchanged' };

  if (accept) {
    writeFileSync(manifestPath, rendered, 'utf8');
    return { status: 'changed', wrote: manifestPath, ...difference(previous, harvested) };
  }

  const actual = actualPath(manifestPath);
  writeFileSync(actual, rendered, 'utf8');
  return { status: 'changed', wrote: actual, ...difference(previous, harvested) };
}

function difference(previous: string, harvested: Manifest): { gone: string[]; added: string[] } {
  let before: Set<string>;
  try {
    before = new Set((JSON.parse(previous) as Manifest).fields.map(key));
  } catch {
    // A manifest that is not JSON at all is a changed file with no entries to name, which is a
    // different sentence from "the entries are the same". Reported as everything having gone rather
    // than as a crash inside the check that was supposed to report it.
    before = new Set();
  }
  const after = new Set(harvested.fields.map(key));
  return {
    gone: [...before].filter((entry) => !after.has(entry)),
    added: [...after].filter((entry) => !before.has(entry)),
  };
}

/**
 * The failure, in words, naming the file to look at and the act that accepts the change.
 *
 * `inert` is separate from `gone` on purpose: a pointer that rendered with no control is not a
 * control somebody deleted, and sending a reader to the wrong one of those costs an afternoon.
 */
export function describeManifest(
  manifestPath: string,
  verdict: ManifestVerdict,
  inert: readonly string[] = [],
): string {
  const lines: string[] = [];
  if (verdict.status === 'absent') {
    lines.push(`No manifest existed. One has been written to ${manifestPath}; read it and commit it.`);
  } else if (verdict.status === 'changed') {
    lines.push(
      `The interface no longer edits what the manifest says it does. ${manifestPath} is unchanged; ` +
        `the harvest is in ${verdict.wrote}.`,
    );
    if (verdict.gone.length > 0) lines.push(`  no longer fillable: ${verdict.gone.join(', ')}`);
    if (verdict.added.length > 0) lines.push(`  newly fillable: ${verdict.added.join(', ')}`);
    if (verdict.gone.length === 0 && verdict.added.length === 0) {
      lines.push('  the entries are the same; the file itself changed shape.');
    }
    lines.push(`  the diff: git diff --no-index ${manifestPath} ${verdict.wrote}`);
    lines.push('  to accept it: WAYFARER_ACCEPT_MANIFEST=1 pnpm --filter @wayfarer/ui test');
  }
  if (inert.length > 0) {
    lines.push(
      `  ${inert.length} pointer(s) rendered with no control a person can fill, so they were not ` +
        `harvested: ${inert.join(', ')}`,
    );
  }
  return lines.join('\n');
}
