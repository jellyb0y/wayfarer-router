import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'deploy', 'bench', 'wayfarer-soak');

async function script(): Promise<string> {
  return await readFile(SCRIPT, 'utf8');
}

/** The script with comment lines removed, so a check cannot match the prose describing the defect. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

test('soak: the sample row has one conversion per value it writes', async () => {
  /*
   * bash's printf reuses the format string when it is given more arguments than conversions. It does
   * not fail, and it does not warn: a twelfth value against an eleven-conversion format wrote every
   * sample as two lines, the second holding one value and ten empty columns. The report then averaged
   * those rows in and announced "card written -38.61 MiB over the window".
   *
   * Counted from the statement itself rather than asserted as a number, because a hardcoded 12 is the
   * same copy-of-a-truth that produces this class of defect in the first place.
   */
  const text = code(await script());
  const statement = /printf '((?:%s\\t)*%s\\n)'((?:\s*\\\n\s*(?:"[^\n]*"|\S+))+)/.exec(text);
  assert.ok(statement, 'the sample row printf should be found');

  const [, format, argumentBlock] = statement;
  const conversions = (format!.match(/%s/g) ?? []).length;

  // Command substitutions are collapsed first: `"$(read_or_zero "$CGROUP/memory.current")"` is one
  // argument containing a nested quoted string, and counting quotes without collapsing it counts two.
  let args = argumentBlock!;
  while (/\$\([^()]*\)/.test(args)) args = args.replace(/\$\([^()]*\)/g, 'X');
  const values = (args.match(/"[^"]*"/g) ?? []).length;

  assert.equal(
    conversions,
    values,
    `printf writes ${values} values through ${conversions} conversions; bash would silently reuse the format`,
  );
});

test('soak: the header declares exactly as many columns as a row writes', async () => {
  // The header is what `report` validates every row against, so the two must agree at the source.
  const text = code(await script());
  const header = /printf '([a-z_]+(?:\\t[a-z_]+)*)\\n' > "\$SERIES"/.exec(text);
  assert.ok(header?.[1], 'the header line should be found');
  const columns = header[1]!.split('\\t').length;

  const statement = /printf '((?:%s\\t)*%s\\n)'/.exec(text);
  assert.ok(statement?.[1], 'the sample row printf should be found');
  const conversions = (statement[1]!.match(/%s/g) ?? []).length;
  assert.equal(columns, conversions, 'the header and the row must declare the same number of columns');
});

test('soak: report refuses a malformed series rather than computing from it', async () => {
  const text = await script();
  assert.match(text, /^check_series\(\)/m, 'there should be a series validity check');
  const report = /^report\(\)\s*\{([\s\S]*?)^\}/m.exec(text)?.[1];
  assert.ok(report, 'report should exist');
  assert.match(report, /check_series \|\| return 1/, 'report must refuse before computing anything');
  // A cumulative counter that has gone backwards is not a quantity, and must not be printed as one.
  assert.match(report, /last_sect < first_sect/);
  assert.match(report, /UNKNOWN/);
});

test('soak: the card device is resolved at runtime and never named in the script', async () => {
  /*
   * The device this card appears as is not stable across boots — mmcblk0 on one boot and mmcblk1 on
   * the next, same card and same image (see docs/12). A sampler with the name written into it would
   * have reported zero card writes for the whole soak and been believed, in the instrument built to
   * measure exactly that.
   */
  const text = code(await script());
  assert.ok(!/mmcblk/.test(text), 'no card device name may appear in the sampler');
  assert.match(text, /findmnt -n -o SOURCE \//, 'the device should be resolved from the mounted root');
});

test('soak: the window is measured from uptime, and the wall clock only labels it', async () => {
  /*
   * The window is printed as "the whole basis for every number below", and the shipped resource limits
   * are set from those numbers — so a wrong window discredits the lot. Two `date +%s` readings either
   * side of the first timesync reported a ninety-six-hour soak from thirty minutes of samples.
   *
   * Asserted from the script rather than by running it, because the failure needs a clock that steps.
   */
  const text = await script();
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  const report = /^report\(\)\s*\{([\s\S]*?)^\}/m.exec(code)?.[1];
  assert.ok(report, 'report should exist');

  // The window comes from the uptime column of the series.
  assert.match(report, /hours="\$\(awk[^\n]*\/3600/, 'the window should be computed in report');
  assert.ok(
    !/hours=.*date /.test(report),
    'the window length must not be computed from any wall-clock reading',
  );
  // The wall-clock note is present and is explicitly not the basis.
  assert.match(text, /a note for a reader; the window above is not computed from it/);
});

test('soak: the rollup gate fails towards writing a line, never towards losing the series', async () => {
  /*
   * The gate exists to keep the card footprint at one line an hour. Its old form compared the wall clock
   * against the epoch of the last line on the card — across boots — so a backward step of an hour stalled
   * rollups, and a reboot then discarded the tmpfs series the rollup exists to preserve.
   *
   * The marker now lives in tmpfs, so a reboot means "write at once". Two properties are asserted: the
   * gate reads uptime, and the marker is under the run directory rather than beside the kept file.
   */
  const text = await script();
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  const rollup = /^rollup\(\)\s*\{([\s\S]*?)^\}/m.exec(code)?.[1];
  assert.ok(rollup, 'rollup should exist');
  assert.match(rollup, /\/proc\/uptime/, 'the gate must be on uptime');
  assert.ok(!/date /.test(rollup), 'no wall-clock reading may gate the rollup');
  assert.match(rollup, /ROLLUP_MARK/);
  assert.match(code, /^ROLLUP_MARK="\$RUN_DIR\//m, 'the marker belongs in tmpfs so a reboot clears it');

  // And the kept file itself is never removed by a reset: throwing away history to make the current
  // window look tidy is not a thing a measurement does.
  const reset = /^reset_window\(\)\s*\{([\s\S]*?)^\}/m.exec(code)?.[1];
  assert.ok(reset, 'reset_window should exist');
  assert.ok(!new RegExp('rm[^\\n]*\\$KEEP').test(reset), 'a reset must not delete the hourly history');
});

test('soak: report refuses a series written by a different sampler, by column name', async () => {
  /*
   * A count check is not enough, and this was caught on the board rather than by reasoning: a series
   * from the previous sampler had twelve columns and a twelve-column header, so it was internally
   * consistent and had no uptime column at all. The window came out as "0.00 hours of continuous
   * sampling, 132 samples" — self-contradictory, and printed rather than refused.
   *
   * Two guards, and the names are derived from one list so the check cannot fall behind the reader.
   */
  const text = await script();
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  const required = /^REQUIRED_COLUMNS="([^"]+)"$/m.exec(code)?.[1];
  assert.ok(required, 'the columns the report needs should be named in one place');

  // Every name in that list must actually appear in the header the sampler writes, or the guard would
  // refuse every series including a correct one.
  const header = /printf '([a-z_]+(?:\\t[a-z_]+)*)\\n' > "\$SERIES"/.exec(code)?.[1];
  assert.ok(header, 'the header line should be found');
  const written = new Set(header.split('\\t'));
  for (const column of required.split(/\s+/)) {
    assert.ok(written.has(column), `report requires "${column}" but the sampler never writes it`);
  }

  // And the count of required columns matches what the row writes, so neither list can drift alone.
  const statement = /printf '((?:%s\\t)*%s\\n)'/.exec(code);
  const conversions = (statement![1]!.match(/%s/g) ?? []).length;
  assert.equal(required.split(/\s+/).length, conversions);

  // The derived contradiction: samples cannot span no time.
  const report = /^report\(\)\s*\{([\s\S]*?)^\}/m.exec(code)?.[1];
  assert.match(report!, /which cannot be true/);
});
