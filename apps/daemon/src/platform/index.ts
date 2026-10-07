/**
 * The platform layer: the only code in this project that knows an operating system
 * exists. Everything above it takes and returns plain data, which is what makes the
 * planner testable without a board and a second platform implementation possible without
 * touching anything else.
 *
 * Every method is either a query or a mutation, never both, and mutations are only ever
 * called from the reconciler. In this epic there is no reconciler, so nothing here that
 * mutates is called at all — the whole surface in use is read-only.
 */

import { createApController, type ApController } from './ap.ts';
import { createBinaryDetector, type BinaryDetector } from './binaries.ts';
import { createClockController, type ClockController } from './clock.ts';
import { createHostReader, type HostReader } from './host.ts';
import {
  createDirectory,
  directoryWritable,
  fileMode,
  findMovedAside,
  moveAside,
  readManaged,
  removeMatchingEntries,
  removePath,
  restoreAside,
  writeAtomic,
} from './files.ts';
import { createJournalReader, type JournalReader } from './journal-reader.ts';
import { createNetReader, type NetReader } from './net.ts';
import { createNftController, type NftController } from './nft.ts';
import { createSupplicantController, type SupplicantController } from './supplicant.ts';
import { createSystemdController, type SystemdController } from './systemd.ts';
import { createWifiReader, type WifiReader } from './wifi.ts';
import { readSysctl, writeSysctl } from './facts.ts';

export interface Platform {
  systemd: SystemdController;
  net: NetReader;
  wifi: WifiReader;
  supplicant: SupplicantController;
  ap: ApController;
  nft: NftController;
  files: {
    readManaged: typeof readManaged;
    writeAtomic: typeof writeAtomic;
    fileMode: typeof fileMode;
    /**
     * Taking a foreign file over, and putting it back. Both live here rather than in the reconciler
     * because they are filesystem operations, and only this layer knows a filesystem exists.
     */
    moveAside: typeof moveAside;
    restoreAside: typeof restoreAside;
    /** Whether a directory can be written to, answered by trying rather than by reading permission bits. */
    directoryWritable: typeof directoryWritable;
    /**
     * Removal and creation, for the factory reset.
     *
     * Here rather than in the command that drives it, for the ordinary reason: only this layer knows a
     * filesystem exists, and the traps — that a missing path is already the desired state, that
     * `mkdir`'s mode is subject to the umask — are recorded here where the next caller will meet them.
     */
    removePath: typeof removePath;
    createDirectory: typeof createDirectory;
    removeMatchingEntries: typeof removeMatchingEntries;
    /** Files a takeover moved aside, discovered from the disk rather than from our own records. */
    findMovedAside: typeof findMovedAside;
  };
  /**
   * Kernel tunables.
   *
   * A read and a write, kept separate as everything else here is: the reconciler is the only caller of
   * the write, and reading is what the differ needs to know whether a write is required at all. Both
   * go through `/proc/sys` rather than the `sysctl` command — one file operation instead of a process,
   * and a missing key is an `ENOENT` rather than a message on standard error that has to be told apart
   * from a real failure.
   */
  sysctl: {
    read: typeof readSysctl;
    write: typeof writeSysctl;
  };
  clock: ClockController;
  host: HostReader;
  binaries: BinaryDetector;
  journal: JournalReader;
  close(): void;
}

export interface PlatformOptions {
  /** Directory for caches the platform layer owns, such as the core's schema. */
  cacheDir: string;
  /** Tool paths, overridable so a different distribution layout is configuration. */
  paths?: {
    ip?: string;
    iw?: string;
    nft?: string;
    hostapdCli?: string;
    systemctl?: string;
    systemdRun?: string;
    networkctl?: string;
    ping?: string;
    timedatectl?: string;
    journalctl?: string;
  };
  coreBinary?: string;
}

export function createPlatform(options: PlatformOptions): Platform {
  const paths = options.paths ?? {};

  const systemd = createSystemdController({
    ...(paths.systemctl ? { systemctlPath: paths.systemctl } : {}),
    ...(paths.systemdRun ? { systemdRunPath: paths.systemdRun } : {}),
  });
  const supplicant = createSupplicantController();

  return {
    systemd,
    net: createNetReader(paths.ip, paths.networkctl, paths.ping),
    wifi: createWifiReader(paths.iw),
    supplicant,
    ap: createApController(paths.hostapdCli),
    nft: createNftController(paths.nft),
    files: {
      readManaged,
      writeAtomic,
      fileMode,
      moveAside,
      restoreAside,
      directoryWritable,
      removePath,
      createDirectory,
      removeMatchingEntries,
      findMovedAside,
    },
    sysctl: { read: readSysctl, write: writeSysctl },
    clock: createClockController(paths.timedatectl, paths.systemctl),
    host: createHostReader(undefined, paths.systemctl),
    binaries: createBinaryDetector({
      cacheDir: options.cacheDir,
      ...(options.coreBinary ? { coreBinary: options.coreBinary } : {}),
    }),
    journal: createJournalReader(paths.journalctl),
    close(): void {
      systemd.close();
      supplicant.close();
    },
  };
}

export type {
  ApController,
  BinaryDetector,
  ClockController,
  HostReader,
  JournalReader,
  NetReader,
  NftController,
  SupplicantController,
  SystemdController,
  WifiReader,
};
