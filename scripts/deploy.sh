#!/bin/bash
# Build on the workstation, copy to a device, restart the unit — under the deadman, always.
#
# There is no cross-compilation step and there never will be: the dependency list has no
# native modules, so the artefact is JavaScript plus static files and the only
# architecture-specific thing on the device is the runtime, which the installer pins and
# verifies.
#
# The device is named by WAYFARER_HOST (an ssh destination) and never hardcoded here:
# a repository that knows the address of one particular board is a repository that only
# works on it.
#
#   WAYFARER_HOST=root@10.0.0.1 ./scripts/deploy.sh                full deploy
#   WAYFARER_HOST=… ./scripts/deploy.sh --fast                     bundle + interface only
#   WAYFARER_HOST=… ./scripts/deploy.sh --window 15                widen the deadman window
#   WAYFARER_HOST=… ./scripts/deploy.sh --no-deadman               deploy with NO safety net
#   WAYFARER_HOST=… ./scripts/deploy.sh --with-sourcemaps          ship the .map files too
#   WAYFARER_HOST=… ./scripts/deploy.sh --keep-payload             leave the install payload behind
#   WAYFARER_HOST=… ./scripts/deploy.sh --listen-interface wlanap  serve on that interface too
#   WAYFARER_HOST=… ./scripts/deploy.sh --no-build                 deploy what is already built
#
# WAYFARER_SSH_KEY is passed to ssh/scp when set.
#
# ── What reaches the device, and what does not ────────────────────────────────────────────
#
# Build artefacts and the installer, and nothing else. There is no source tree on the device
# and no package directory: the daemon is a single bundled file by design and the interface is
# static assets, so nothing the runtime does needs either. The staging directory is named for
# what it holds — an install payload — and it is **removed once the install succeeds**, because
# a directory left on the card is a second copy of the artefacts that nothing will ever read
# again and that the next reader will mistake for the running version.
#
# Sourcemaps are opt-in rather than shipped. Measured on this tree: the daemon bundle is 3.0 MB
# and its map is 5.6 MB, the CLI is 0.5 MB and its map is 1.1 MB — so the maps are two thirds of
# the whole payload and the device works identically without them. The card is the only part of
# this device that wears out, so a development artefact that doubles every deploy's write volume
# is one to ask for rather than one to receive by default.
#
# Free space is checked before anything is written. Losing a connection is a terrible way to
# discover a full filesystem, and a preflight that names the numbers is one line of output
# against an afternoon with a card reader.
#
# ── Why the deadman is armed by default, and why arming is not the same as snapshotting ──
#
# A deploy reconfigures a device that may only be reachable over the network it is about to
# touch, so every deploy is a change that can cost access. The previous behaviour made the
# safety net an opt-in flag, and the predictable thing happened: it was passed for a risky
# apply and left off for a deploy that had worked before, that deploy died mid-copy, and the
# board needed a human with a card reader. **A safety net that depends on somebody
# remembering is not a safety net**, so arming is now the default and skipping it is an
# explicit, loud act.
#
# It arms from the snapshot that is already on the device and **never takes one**. That
# distinction is load-bearing rather than pedantic. A snapshot is a claim that the current
# configuration is known good; taking one automatically at the start of a deploy would bless
# whatever state the device happens to be in — including a half-applied one from a deploy
# that just failed — as the state to fall back to, which turns the safety net into a way to
# make a broken configuration permanent. So a device with no snapshot makes this script
# refuse and say which command to run, after a human has looked at the board.
#
# Disarming happens only after the daemon has answered. On any other exit the deadman is left
# armed and the script says so: the board then restores its last known-good network
# configuration and reboots on its own, which is the entire point. The earlier version
# disarmed unconditionally in an EXIT trap, so a deploy that broke the network tidied away the
# thing that would have fixed it.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${WAYFARER_HOST:-}"
FAST=0
BUILD=1
DEADMAN=1
# Ten minutes rather than the deadman's own five-minute default: the window has to cover the
# whole deploy *and* its verification, and a full run copies a bundle, the interface and the
# installer's tree over a wireless link. A window that expires mid-deploy is not dangerous —
# the restore-and-reboot is exactly what recovers a wedged board — but it is a spurious
# interruption, and the number is stated here so it can be measured and corrected rather than
# guessed at twice.
WINDOW_MINUTES=10
LISTEN_INTERFACE=""
SOURCEMAPS=0
KEEP_PAYLOAD=0
# Named for what it is. The previous name said "src", which was never true — nothing but build
# artefacts and the installer has ever been copied — and a misleading name on a device is how
# somebody later concludes the board is running from a source checkout.
REMOTE_PAYLOAD=/opt/wayfarer-install
# Enough for the payload written twice (staged, then installed) plus the runtime archive the
# installer fetches and unpacks when no suitable runtime is present. A stated margin rather than a
# tight computation: the point is to refuse early with numbers, not to model the installer.
REQUIRED_FREE_MB=300

log() { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] WARNING: %s\n' "$*" >&2; }
die() { printf '[deploy] error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    --fast) FAST=1 ;;
    --no-build) BUILD=0 ;;
    --no-deadman) DEADMAN=0 ;;
    --window) WINDOW_MINUTES="$2"; shift ;;
    --with-sourcemaps) SOURCEMAPS=1 ;;
    --keep-payload) KEEP_PAYLOAD=1 ;;
    # Kept as an alias so an existing habit still works, and it now only sets the window:
    # arming is no longer something a flag turns on.
    --arm) WINDOW_MINUTES="$2"; shift ;;
    --listen-interface) LISTEN_INTERFACE="$2"; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ -n "$HOST" ] || die "set WAYFARER_HOST (an ssh destination) or pass --host"
case "$WINDOW_MINUTES" in
  ''|*[!0-9]*) die "--window takes a positive whole number of minutes" ;;
esac
[ "$WINDOW_MINUTES" -gt 0 ] || die "--window takes a positive whole number of minutes"

SSH_ARGS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
[ -n "${WAYFARER_SSH_KEY:-}" ] && SSH_ARGS+=(-i "$WAYFARER_SSH_KEY")

on_device() { ssh "${SSH_ARGS[@]}" "$HOST" "$@"; }
copy_to_device() { rsync -az -e "ssh ${SSH_ARGS[*]}" "$@"; }

# ── build, locally, before the device is touched at all ───────────────────────────────────

if [ "$BUILD" = 1 ]; then
  log "building"
  (cd "$REPO" && pnpm run build)
fi

[ -f "$REPO/apps/daemon/dist/daemon.cjs" ] || die "no bundle; run without --no-build"

# ── how much is about to be written, and whether it fits ──────────────────────────────────

# The artefacts that reach the device, listed rather than mirrored. A directory mirror ships
# whatever happens to be in the directory, which is how a build output nobody meant to send
# starts travelling to a board.
PAYLOAD=("$REPO/apps/daemon/dist/daemon.cjs" "$REPO/apps/daemon/dist/way.cjs")
[ -f "$REPO/apps/daemon/dist/build.json" ] && PAYLOAD+=("$REPO/apps/daemon/dist/build.json")
if [ "$SOURCEMAPS" = 1 ]; then
  for map in "$REPO/apps/daemon/dist/daemon.cjs.map" "$REPO/apps/daemon/dist/way.cjs.map"; do
    [ -f "$map" ] && PAYLOAD+=("$map")
  done
fi

payload_kb() {
  # `du -k` of the artefacts plus the interface and the installer tree, summed on this side so the
  # number can be reported before the device is contacted at all.
  local total=0 size
  for entry in "${PAYLOAD[@]}" "$REPO/deploy"; do
    [ -e "$entry" ] || continue
    size="$(du -sk "$entry" | awk '{print $1}')"
    total=$((total + size))
  done
  if [ -d "$REPO/apps/ui/dist" ]; then
    size="$(du -sk "$REPO/apps/ui/dist" | awk '{print $1}')"
    total=$((total + size))
  fi
  printf '%s' "$total"
}

PAYLOAD_KB="$(payload_kb)"
log "payload $((PAYLOAD_KB / 1024)) MB$([ "$SOURCEMAPS" = 1 ] && printf ' (including sourcemaps)' || printf ' (sourcemaps omitted; --with-sourcemaps to include)')"

require_device() {
  # Before any check that could be *explained* by the device being unreachable.
  #
  # Observed 2026-09-21: with the wrong ssh key, the first thing this script said was "could not
  # read free space on the device; proceeding without the check" — a warning about disk space on a
  # board it had never connected to, followed by a proceed. The same shape as a diagnosis offered
  # with false confidence: the message named the check that happened to be first rather than the
  # thing that was actually wrong, and "proceeding without the check" invited it to be ignored.
  #
  # A refusal, not a warning, because nothing below this line can work if this fails.
  if ! on_device 'true' >/dev/null 2>&1; then
    die "$(printf '%s\n' \
      "cannot reach the device over ssh as '$HOST'. Nothing has been read and nothing written." \
      '' \
      'Check the destination, and the key if one is needed:' \
      '    WAYFARER_SSH_KEY=/path/to/key' \
      '' \
      'This is a refusal rather than a warning because every check below would otherwise fail for' \
      'this reason and report itself as the problem.')"
  fi
}

check_free_space() {
  # `df -kP` for POSIX single-line output: the default format wraps a long device name onto its own
  # line, and a reader that takes field 4 of the wrapped line gets the mount point instead of a
  # number. Checked against /opt, because that is where both the payload and the install land.
  local report available_kb
  report="$(on_device 'df -kP /opt 2>/dev/null || df -kP /' || true)"
  available_kb="$(printf '%s\n' "$report" | awk 'NR==2 {print $4}')"
  case "${available_kb:-}" in
    ''|*[!0-9]*)
      # The device is known reachable by now, so this is a df that answered something unexpected —
      # a filesystem type with no usable figure, say. A warning rather than a refusal because the
      # margin is a courtesy and a strange df should not stop a deploy that would otherwise work.
      warn "the device is reachable but its free space could not be read; proceeding without the margin check"
      warn "df said: $(printf '%s' "$report" | tr '\n' ' ')"
      return 0
      ;;
  esac

  local needed_kb=$((PAYLOAD_KB + REQUIRED_FREE_MB * 1024))
  log "device has $((available_kb / 1024)) MB free; this deploy wants $((needed_kb / 1024)) MB"
  if [ "$available_kb" -lt "$needed_kb" ]; then
    die "$(printf '%s\n' \
      "not enough free space on the device: $((available_kb / 1024)) MB available," \
      "$((needed_kb / 1024)) MB wanted (payload $((PAYLOAD_KB / 1024)) MB plus a ${REQUIRED_FREE_MB} MB margin" \
      'for the staged copy, the installed copy and the runtime archive).' \
      '' \
      'Nothing has been written. Free space on the device, or pass --fast to skip the installer' \
      'payload if the runtime is already in place.')"
  fi
}

# ── the safety net, before anything on the device changes ─────────────────────────────────

DEADMAN_ARMED=0
DEPLOY_VERIFIED=0

# Disarm on success only. Every other exit leaves the deadman armed on purpose, and says so
# loudly enough that nobody mistakes it for a tidy failure: a script that exits early must not
# leave a broken board unattended, and the way it avoids that is by NOT cancelling the thing
# that is about to fix it.
finish() {
  if [ "$DEADMAN_ARMED" != 1 ]; then return; fi
  if [ "$DEPLOY_VERIFIED" = 1 ]; then
    log "the daemon answered; disarming the deadman"
    on_device 'wayfarer-deadman disarm' || warn "could not disarm — run 'wayfarer-deadman disarm' on the device"
    DEADMAN_ARMED=0
    return
  fi
  warn "this deploy did NOT verify, so the deadman is being left ARMED."
  # The remaining time is read from the device rather than computed from WINDOW_MINUTES: the person
  # reading this is already having a bad day, and "how long until the board fixes itself" is the only
  # question they have. An arithmetic answer would also be wrong by however long the deploy ran.
  LEFT="$(on_device 'wayfarer-deadman status' 2>/dev/null | sed -n 's/^armed: \(.*\)$/\1/p' | head -1 || true)"
  warn "time left before it restores and reboots: ${LEFT:-unknown — run 'wayfarer-deadman status' on the device}"
  warn "the device will restore its last known-good network configuration and reboot on its own."
  warn "Let it. If you are certain the board is healthy, run this on the device yourself:"
  warn "    wayfarer-deadman status     # check what it is about to do"
  warn "    wayfarer-deadman disarm     # only once you are sure"
}
trap finish EXIT

# Reachability first, so no later check can be blamed for it. Both are pure reads, and a refusal
# from either must cost nothing. Arming first and refusing second would leave a deadman armed over
# a deploy that never started, and the board would restore and reboot for no reason — found by a
# test asserting that a refusal copies nothing, which is exactly the kind of ordering a human
# reading the script does not check.
require_device
check_free_space

if [ "$DEADMAN" = 1 ]; then
  # The device always carries the repository's copy of the script, so a board can never be
  # protected by a version nobody can read. Installing it changes no network configuration, so
  # it is safe to do before the net is armed.
  log "installing the bench deadman from this tree"
  copy_to_device "$REPO/deploy/bench/wayfarer-deadman" "$HOST:/usr/local/sbin/wayfarer-deadman"
  on_device 'chmod 0755 /usr/local/sbin/wayfarer-deadman'

  DEADMAN_STATUS="$(on_device 'wayfarer-deadman status' 2>&1 || true)"
  printf '%s\n' "$DEADMAN_STATUS" | sed 's/^/[deadman] /'

  case "$DEADMAN_STATUS" in
    *'snapshot: none'*)
      die "$(printf '%s\n' \
        'this device has no known-good snapshot, so the deadman has nothing to restore and' \
        'arming it would only reboot the board without changing anything.' \
        '' \
        'This script will not take one for you. A snapshot is a claim that the configuration is' \
        'good, and taking one automatically would bless whatever state the board is in right' \
        'now — possibly a half-applied one — as the state to fall back to.' \
        '' \
        'Check the board is healthy, then on the device run:' \
        '    wayfarer-deadman snapshot' \
        '' \
        'To deploy with no safety net at all, pass --no-deadman and understand what that means.')"
      ;;
  esac

  case "$DEADMAN_STATUS" in
    *'armed: no'*) : ;;
    *)
      die "$(printf '%s\n' \
        'a deadman is already armed on this device. Two arms cannot coexist — the unit name is' \
        'fixed on purpose, so the second one fails — and an arm already running means somebody' \
        'else is mid-change on this board.' \
        '' \
        'Wait for it, or disarm it on the device once you know the board is healthy.')"
      ;;
  esac

  log "arming the deadman for ${WINDOW_MINUTES} min around this deploy"
  on_device "wayfarer-deadman arm $WINDOW_MINUTES"
  DEADMAN_ARMED=1
else
  warn "deploying with NO deadman. If this deploy takes the network with it, the board stays"
  warn "broken until somebody reaches it physically. This is why --no-deadman is not the default."
fi

# ── the deploy itself ─────────────────────────────────────────────────────────────────────

if [ "$FAST" = 1 ]; then
  log "copying the build artefacts and the interface"
  for artefact in "${PAYLOAD[@]}"; do
    copy_to_device "$artefact" "$HOST:/opt/wayfarer/$(basename "$artefact")"
  done
  if [ -d "$REPO/apps/ui/dist" ]; then
    copy_to_device --delete "$REPO/apps/ui/dist/" "$HOST:/opt/wayfarer/ui/"
  fi
  log "restarting"
  on_device 'systemctl restart wayfarer.service'
else
  # The installer reads a tree shaped like the repository, so the payload reproduces that shape —
  # but it carries only the artefacts the installer names and the installer's own scripts. No
  # sources, no dependencies, nothing that has to be built on the device.
  log "staging the install payload in $REMOTE_PAYLOAD"
  on_device "mkdir -p $REMOTE_PAYLOAD/apps/daemon/dist $REMOTE_PAYLOAD/apps/ui $REMOTE_PAYLOAD/deploy"
  copy_to_device --delete "$REPO/deploy/" "$HOST:$REMOTE_PAYLOAD/deploy/"
  # `--delete` on the dist directory as well, so a sourcemap left by an earlier
  # `--with-sourcemaps` run does not linger on the card after being turned off.
  copy_to_device --delete "${PAYLOAD[@]}" "$HOST:$REMOTE_PAYLOAD/apps/daemon/dist/"
  if [ -d "$REPO/apps/ui/dist" ]; then
    copy_to_device --delete "$REPO/apps/ui/dist/" "$HOST:$REMOTE_PAYLOAD/apps/ui/dist/"
  fi
  log "running the installer (host settings skipped: use install.sh directly to apply them)"
  on_device "chmod +x $REMOTE_PAYLOAD/deploy/install.sh $REMOTE_PAYLOAD/deploy/set-fsck-repair.sh $REMOTE_PAYLOAD/deploy/bench/wayfarer-deadman && $REMOTE_PAYLOAD/deploy/install.sh --skip-host-settings"

  # Removed once it has done its job. Keeping it would leave a second copy of every artefact on
  # the card, which the next person to look would reasonably mistake for the running version.
  if [ "$KEEP_PAYLOAD" = 1 ]; then
    log "leaving the payload at $REMOTE_PAYLOAD as asked"
  else
    log "removing the install payload"
    # The path is a constant in this script and never interpolated from input, so there is nothing
    # here a caller could turn into a different directory.
    on_device "rm -rf $REMOTE_PAYLOAD" || warn "could not remove $REMOTE_PAYLOAD"
  fi

  # An earlier version of this script staged into /opt/wayfarer-src, which is still on any board
  # deployed before this change. Cleaning it up here rather than in a note somebody has to read.
  on_device 'rm -rf /opt/wayfarer-src' || true
fi

if [ -n "$LISTEN_INTERFACE" ]; then
  # The interface NAME is configuration; an address would not be. The daemon resolves the name to
  # whatever addresses the kernel reports and re-resolves when they change, so this survives a
  # lease renewal and refuses to guess when the interface has no address yet.
  log "configuring the daemon to serve on $LISTEN_INTERFACE as well as loopback"
  on_device "python3 - <<'PY'
import json, pathlib
path = pathlib.Path('/etc/wayfarer/daemon.json')
config = json.loads(path.read_text()) if path.exists() else {}
listen = config.setdefault('listen', {})
listen.setdefault('port', 8088)
listen.setdefault('addresses', ['127.0.0.1'])
interfaces = listen.setdefault('interfaces', [])
if '$LISTEN_INTERFACE' not in interfaces:
    interfaces.append('$LISTEN_INTERFACE')
path.write_text(json.dumps(config, indent=2) + '\n')
print('listen:', json.dumps(listen))
PY"
  on_device 'systemctl restart wayfarer.service'
fi

# ── verify by result, and only then stand the safety net down ─────────────────────────────

log "verifying by result"
on_device 'systemctl is-active wayfarer.service; systemctl is-enabled wayfarer.service' || true
PORT="$(on_device 'sed -n "s/.*\"port\":[[:space:]]*\([0-9]*\).*/\1/p" /etc/wayfarer/daemon.json | head -1' || true)"
PORT="${PORT:-8088}"
if on_device "curl -fsS --max-time 5 http://127.0.0.1:$PORT/api/health"; then
  echo
  log "the daemon answered on port $PORT"
  # The one place this is set. Nothing above may set it, because "the deploy finished" and "the
  # daemon is answering" are different claims and only the second one earns a disarm.
  DEPLOY_VERIFIED=1
else
  log "the daemon did not answer on port $PORT; recent log:"
  on_device 'journalctl -u wayfarer.service -n 30 --no-pager' || true
  exit 1
fi
