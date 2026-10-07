/**
 * Firewall access: generate a file, check it, apply it as one transaction, read it back
 * as JSON.
 *
 * `nft -c -f` before `nft -f` is the habit worth keeping: a syntax error in a generated
 * ruleset is caught before anything is touched.
 *
 * Two hard rules enforced here rather than left to the generator:
 *
 * * **`flush ruleset` is rejected.** Measured on the bench board, the live ruleset holds
 *   four tables in the `inet` family and at least two belong to other software; a proxy
 *   core creates its own table when it manages redirection. A global flush deletes it
 *   and silently disables tunnelling on any restart of the firewall service. Owned
 *   tables are recreated with the `table` / `delete table` / `table` idiom instead.
 * * **A snapshot of the live ruleset is not a rollback plan.** Output that includes
 *   another program's tables cannot be re-applied cleanly, so rollback re-applies our
 *   generated file for the previous configuration, which we already have.
 */

import { run } from './exec.ts';
import { foreignTables, parseNftRuleset, type NftRuleset, type NftTable } from './parse/nft-json.ts';
import { writeAtomic } from './files.ts';

export class ForbiddenRulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenRulesetError';
  }
}

export interface NftCheckResult {
  ok: boolean;
  /** `nft`'s own message, which names the line — the reason to surface it verbatim. */
  message: string;
}

export interface NftController {
  /** Validate without changing anything. */
  check(ruleset: string): Promise<NftCheckResult>;
  /** Validate, then apply as one transaction. Never applies an unchecked ruleset. */
  apply(ruleset: string, path: string): Promise<void>;
  list(): Promise<NftRuleset>;
  /** Tables present in the live ruleset that are not in `owned`. */
  foreign(owned: Iterable<string>): Promise<NftTable[]>;
  /**
   * Deletes one table by family and name, and only that one.
   *
   * Never a ruleset flush: the live ruleset on this device holds tables belonging to other software, and
   * a flush removes them silently. Succeeds when the table is already absent, because "this table is not
   * here" is the state being asked for.
   */
  deleteTable(family: string, name: string): Promise<{ ok: boolean; message: string }>;
}

const NFT = '/usr/sbin/nft';

export function createNftController(nftPath = NFT): NftController {
  const rejectFlush = (ruleset: string): void => {
    // Comments are stripped before the check so a mention in a comment does not trip it
    // and a real command hidden after a comment marker cannot slip through.
    const code = ruleset
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    if (/\bflush\s+ruleset\b/.test(code)) {
      throw new ForbiddenRulesetError(
        'refusing a ruleset containing "flush ruleset": it would delete tables owned by ' +
          'other software on this device, silently disabling their traffic handling. ' +
          'Recreate owned tables with delete table / table instead.',
      );
    }
  };

  return {
    async check(ruleset) {
      rejectFlush(ruleset);
      // `-f -` reads from stdin, so a check needs no file on the card at all.
      const result = await run(nftPath, ['-c', '-f', '-'], { stdin: ruleset, timeoutMs: 10_000 });
      return {
        ok: result.code === 0,
        message: (result.stderr + result.stdout).trim(),
      };
    },

    async apply(ruleset, path) {
      rejectFlush(ruleset);
      const checked = await run(nftPath, ['-c', '-f', '-'], { stdin: ruleset, timeoutMs: 10_000 });
      if (checked.code !== 0) {
        throw new Error(`generated ruleset failed nft -c: ${(checked.stderr + checked.stdout).trim()}`);
      }

      // The file is written first and applied from disk, so what was applied is exactly
      // what is on the card for the next boot — applying from stdin and writing the file
      // afterwards can leave the two disagreeing if the write fails.
      await writeAtomic(path, ruleset.endsWith('\n') ? ruleset : `${ruleset}\n`, { mode: 0o600 });
      const applied = await run(nftPath, ['-f', path], { timeoutMs: 30_000 });
      if (applied.code !== 0) {
        throw new Error(`nft -f ${path} failed: ${(applied.stderr + applied.stdout).trim()}`);
      }
    },

    async list() {
      const result = await run(nftPath, ['-j', 'list', 'ruleset'], {
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
      });
      return parseNftRuleset(result.stdout);
    },

    async deleteTable(family, name) {
      const result = await run(nftPath, ['delete', 'table', family, name], { timeoutMs: 15_000 });
      const output = (result.stderr + result.stdout).trim();
      // `No such file or directory` is nft's way of saying the table is not there, which is the goal.
      const absent = /no such file or directory/i.test(output);
      return { ok: result.code === 0 || absent, message: absent ? `already absent: ${output}` : output };
    },

    async foreign(owned) {
      const result = await run(nftPath, ['-j', 'list', 'ruleset'], {
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
      });
      return foreignTables(parseNftRuleset(result.stdout), owned);
    },
  };
}
