/**
 * Facts about the machine that can only be read from the operating system.
 *
 * This exists because the inventory module had a `/proc/device-tree/model` read in it, directly
 * under a header promising that every conclusion is traceable through the platform abstraction. The
 * irony is the point: a single path read looks too small to be worth a module until it is the one
 * thing standing between the planner and a test that runs on a laptop.
 *
 * Anything the runtime itself can answer — architecture, core count, total memory — stays in the
 * caller, because that is not knowledge about *this* operating system.
 */

import { readFile } from 'node:fs/promises';
import { run } from './exec.ts';

/**
 * How to ask a displaced network manager to re-apply its own configuration.
 *
 * A **closed table**, and the closedness is the point. Running the command a manager publishes, purely
 * to complete our own undo of our own change, is not adopting or owning anything of theirs — it is the
 * difference between managing somebody else's system and putting back what we moved. But that argument
 * only holds while the set of things we may run is fixed and small, so the reload command is looked up
 * here by the name of the manager we displaced and can never come from a caller.
 *
 * Why it is needed at all: **restoring a file is not restoring an effect.** Putting
 * `/etc/netplan/20-wifi.yaml` back does nothing about netplan's running state — its supplicant has
 * already lost the radio, and its generated files live in `/run` where only netplan regenerates them.
 * Measured on the bench board: a takeover of the interface carrying the management session was
 * *configuration*-reversible and not *effect*-reversible, so the device never came back and the bench
 * deadman had to rescue it.
 */
export const MANAGER_RELOAD: Readonly<Record<string, { command: string; args: string[] }>> = {
  netplan: { command: '/usr/sbin/netplan', args: ['apply'] },
};

export interface ForeignReloadResult {
  manager: string;
  /** What was run, so the transaction records the action and not just the intent. */
  command: string;
  ok: boolean;
  detail: string;
}

export interface HostReader {
  /** Seconds since the machine booted, on the clock systemd's monotonic timestamps use. */
  uptimeSeconds(): Promise<number | null>;
  /**
   * The board's own name, from the device tree. Null on hardware that publishes none, which is a
   * state rather than an error: x86 machines have no device tree at all.
   */
  boardModel(): Promise<string | null>;
  /**
   * Asks a displaced manager to re-apply its own configuration.
   *
   * Refuses any manager not in `MANAGER_RELOAD`, so this cannot become a general way to run commands.
   * Bounded by a timeout, because the whole reason it is being called is that the device may already be
   * unreachable and a hung command would consume the confirmation window.
   */
  reloadForeignManager(manager: string, timeoutMs?: number): Promise<ForeignReloadResult>;
  /**
   * A clean reboot, as the last resort when an effect cannot be restored any other way.
   *
   * Separate from everything else here because it is the one call that ends the process making it. The
   * caller must have finished writing whatever record explains why.
   */
  reboot(reason: string): Promise<{ ok: boolean; detail: string }>;
}

const DEVICE_TREE_MODEL = '/proc/device-tree/model';

export function createHostReader(modelPath = DEVICE_TREE_MODEL, systemctlPath = '/usr/bin/systemctl'): HostReader {
  return {
    /**
     * Seconds since this **machine** booted, on the same clock systemd timestamps units with.
     *
     * Read from `/proc/uptime`, which is CLOCK_MONOTONIC since boot — the clock
     * `ActiveEnterTimestampMonotonic` is expressed in. Provided here because the alternative was reached
     * for once and was wrong: `process.uptime()` is seconds since *this process* started, and
     * subtracting a boot-relative timestamp from it produces a number with no meaning. Clamped at zero,
     * it produced a constant zero — so the guard that used it could never fire.
     *
     * `null` when it cannot be read, which callers must treat as "I do not know" rather than as zero.
     */
    async uptimeSeconds(): Promise<number | null> {
      try {
        const raw = await readFile('/proc/uptime', 'utf8');
        const seconds = Number(raw.trim().split(/\s+/)[0]);
        return Number.isFinite(seconds) ? seconds : null;
      } catch {
        return null;
      }
    },

    async boardModel(): Promise<string | null> {
      try {
        // The device tree stores strings NUL-terminated, so the trailing byte has to come off or
        // the name carries an invisible character into every log line and every interface label.
        const raw = await readFile(modelPath, 'utf8');
        const trimmed = raw.replace(/\0+$/, '').trim();
        return trimmed === '' ? null : trimmed;
      } catch {
        return null;
      }
    },

    async reloadForeignManager(manager, timeoutMs = 60_000) {
      const entry = MANAGER_RELOAD[manager];
      if (entry === undefined) {
        // Not an error to throw on: a manager we have no reload for is a normal outcome, and the caller
        // falls through to its own fallback. Saying which manager it was is what makes that legible.
        return {
          manager,
          command: '',
          ok: false,
          detail: `no published reload command is known for ${manager}`,
        };
      }
      const printable = [entry.command, ...entry.args].join(' ');
      const result = await run(entry.command, entry.args, { timeoutMs });
      return {
        manager,
        command: printable,
        ok: result.code === 0,
        detail: result.code === 0 ? 'reloaded' : (result.stderr + result.stdout).trim() || `exit ${String(result.code)}`,
      };
    },

    async reboot(reason) {
      // `systemctl reboot` rather than `reboot -f`: the moment this is called is a bad moment to abandon
      // a card mid-write, and everything that explains the reboot has already been written by the caller.
      const result = await run(systemctlPath, ['reboot'], { timeoutMs: 30_000 });
      return {
        ok: result.code === 0,
        detail: result.code === 0 ? `rebooting: ${reason}` : (result.stderr + result.stdout).trim(),
      };
    },
  };
}
