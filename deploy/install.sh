#!/bin/bash
# Wayfarer installer.
#
# Idempotent and safe to re-run: every step checks the state it wants before changing
# anything, so a second run on a healthy device changes nothing and writes nothing to the
# card.
#
# What it deliberately does NOT do:
#   * configure the network — that is the daemon's job, from its own configuration;
#   * stop, reconfigure or remove anything it did not install — with one listed exception: the
#     distribution units in STOCK_UNITS_TO_MASK, which contend with ours for the same sockets, are
#     stopped, disabled and masked, each with its reason logged (see mask_conflicting_stock_units);
#   * install proxy cores automatically (they are listed as prerequisites and reported
#     through the API when absent, with the command to install them).
#
# Options:
#   --skip-host-settings   do not touch the kernel command line or the filesystem check
#                          interval. Required on a machine shared with other software,
#                          and the right default for anything but a dedicated device.
#   --prefix DIR           install root for the bundle (default /opt/wayfarer)
#   --no-runtime           do not install the runtime (use one already present)
#   --dry-run              print what would change and exit

set -euo pipefail

PREFIX=/opt/wayfarer
STATE_DIR=/var/lib/wayfarer
CONFIG_DIR=/etc/wayfarer
RUNTIME_PREFIX=/opt/node-24
UNIT_NAME=wayfarer.service

# Where our units go, and it is **not** /etc/systemd/system.
#
# systemd masks a unit by creating a symlink to /dev/null at /etc/systemd/system/<unit>, so a unit file
# written to that path makes masking impossible. Measured on the bench board:
#
#   # systemctl mask wayfarer
#   Failed to mask unit: File '/etc/systemd/system/wayfarer.service' already exists
#
# That disabled the bench safety net's central action — taking our software out of the boot path — and it
# failed *silently* from the operator's point of view: the board rescued itself, rebooted, and locked
# itself out again because the unit it was supposed to have masked started normally.
#
# The partial behaviour is the dangerous part. A template *instance* masks fine, because nothing occupies
# its path; the template, every plain unit and the daemon do not. So a rescue would half-work.
#
# /etc/systemd/system belongs to the administrator: it is where overrides and masks go. /usr/local/lib is
# the correct home for locally installed units — searched at lower precedence, and it leaves both
# overriding and masking available, which is the whole point.
UNIT_DIR=/usr/local/lib/systemd/system

# The distribution's own units that contend with ours, one entry each: "<unit>|<why it is masked>".
#
# Mirrored by CONFLICTING_STOCK_UNITS in apps/daemon/src/platform/stock-units.ts, which the daemon's drift
# check reads to report a unit that is no longer masked. test/stock-units.test.ts fails when the two lists
# differ in a name or a reason, so change both. That file also records the units deliberately NOT here —
# wpa_supplicant.service and hostapd.service — and why.
#
# Observed on the bench board, 2026-09-24: the stock dnsmasq.service was enabled and failed at every boot
# while wf-dhcp@<ap>.service served the access point. Nothing orders the two; whichever binds first wins.
STOCK_UNITS_TO_MASK=(
  "dnsmasq.service|wf-dhcp@ serves DHCP/DNS on the AP; the stock unit races it for ports 53/67"
)

SKIP_HOST_SETTINGS=0
INSTALL_RUNTIME=1
DRY_RUN=0

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '[wayfarer] %s\n' "$*"; }
warn() { printf '[wayfarer] warning: %s\n' "$*" >&2; }
die()  { printf '[wayfarer] error: %s\n' "$*" >&2; exit 1; }
run_step() { if [ "$DRY_RUN" = 1 ]; then printf '[wayfarer] would run: %s\n' "$*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-host-settings) SKIP_HOST_SETTINGS=1 ;;
    --prefix) PREFIX="$2"; shift ;;
    --no-runtime) INSTALL_RUNTIME=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$(id -u)" = 0 ] || die "must run as root"

# --- prerequisites ----------------------------------------------------------
# Each check names what is missing and how to get it. An installer that fails halfway
# through is worse than one that refuses at the start.

check_prerequisites() {
  local missing=() optional_missing=()

  command -v systemctl >/dev/null || missing+=("systemd (systemctl not found)")

  local required_commands=(ip iw nft hostapd hostapd_cli wpa_supplicant dnsmasq journalctl timedatectl rsync tar)
  for command_name in "${required_commands[@]}"; do
    command -v "$command_name" >/dev/null || missing+=("$command_name")
  done

  # Optional: absence limits which tunnel types are available and is reported through the
  # API rather than being an installation failure. `ping` (iputils) is how a tunnel with no probe
  # target of its own is measured against the address its peer pushed; without it such a tunnel
  # reads "not measured" and its guard never moves, which is the state before it existed.
  for command_name in sing-box xray openvpn ping; do
    command -v "$command_name" >/dev/null || optional_missing+=("$command_name")
  done

  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64|x86_64) ;;
    *) missing+=("unsupported architecture: $arch (arm64 or amd64)") ;;
  esac

  local mem_kb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  [ "${mem_kb:-0}" -ge 450000 ] || missing+=("at least 512 MB RAM (found $((mem_kb / 1024)) MB)")

  # At least one radio must be capable of access-point mode, and that is asked of the
  # driver rather than assumed from the hardware being present.
  if command -v iw >/dev/null; then
    # Counted rather than matched with `grep -q`. Under `set -o pipefail`, `grep -q` exits as soon
    # as it matches, `iw phy` then dies of SIGPIPE with status 141, and the pipeline reports
    # failure *because the match succeeded* — measured on the bench board, where this printed
    # "no radio reports AP mode support" on hardware with two AP-capable radios.
    local ap_modes
    ap_modes="$(iw phy 2>/dev/null | grep -cE '^[[:space:]]*\*[[:space:]]*AP$' || true)"
    if [ "${ap_modes:-0}" -eq 0 ]; then
      warn "no radio reports AP mode support. The device can still be managed over Ethernet, but it cannot host its own access point."
    fi
  fi

  if [ "${#missing[@]}" -gt 0 ]; then
    printf '[wayfarer] error: prerequisites are missing:\n' >&2
    printf '  - %s\n' "${missing[@]}" >&2
    printf '\nInstall the distribution packages first:\n  apt install hostapd dnsmasq nftables iproute2 iw wpasupplicant openvpn jq rsync\n' >&2
    exit 1
  fi

  if [ "${#optional_missing[@]}" -gt 0 ]; then
    log "optional binaries not found: ${optional_missing[*]}"
    log "  tunnel types needing them are reported as unavailable in the interface, with the command to install them."
  fi
}

# --- runtime ----------------------------------------------------------------

install_runtime() {
  # shellcheck source=deploy/runtime.env
  . "$SOURCE_DIR/deploy/runtime.env"

  local arch_tag sha
  case "$(uname -m)" in
    aarch64|arm64) arch_tag=linux-arm64; sha="$NODE_SHA256_linux_arm64" ;;
    x86_64) arch_tag=linux-x64; sha="$NODE_SHA256_linux_x64" ;;
    *) die "no pinned runtime for $(uname -m)" ;;
  esac

  local target="$RUNTIME_PREFIX"
  if [ -x "$target/bin/node" ]; then
    local have
    have="$("$target/bin/node" --version 2>/dev/null || true)"
    if [ "$have" = "$NODE_VERSION" ]; then
      log "runtime $NODE_VERSION already installed at $target"
      link_runtime
      return
    fi
    log "runtime at $target is $have, replacing with $NODE_VERSION"
  fi

  local archive="node-$NODE_VERSION-$arch_tag.tar.xz"
  local url="$NODE_BASE_URL/$NODE_VERSION/$archive"
  # Download into the install root, not /tmp: /tmp is a tmpfs on these boards, so a
  # 40 MB archive there competes with the RAM the daemon and the journal need.
  local work="${RUNTIME_PREFIX}.download"
  run_step rm -rf "$work"
  run_step mkdir -p "$work"

  log "fetching $url"
  if [ "$DRY_RUN" = 0 ]; then
    if command -v curl >/dev/null; then
      curl -fsSL -o "$work/$archive" "$url"
    elif command -v wget >/dev/null; then
      wget -q -O "$work/$archive" "$url"
    else
      die "neither curl nor wget is available to fetch the runtime"
    fi

    local actual
    actual="$(sha256sum "$work/$archive" | awk '{print $1}')"
    if [ "$actual" != "$sha" ]; then
      rm -rf "$work"
      die "runtime checksum mismatch for $archive
  expected $sha
  actual   $actual
This is either a corrupted download or a tampered archive. Nothing was installed."
    fi
    log "checksum verified: $actual"

    tar -xJf "$work/$archive" -C "$work"
    rm -rf "$target.old"
    [ -d "$target" ] && mv "$target" "$target.old"
    mv "$work/node-$NODE_VERSION-$arch_tag" "$target"
    rm -rf "$work" "$target.old"
    sync
  fi

  link_runtime
}

link_runtime() {
  # A symlink rather than a PATH change: the systemd unit has a minimal environment and
  # must find the runtime by absolute path anyway.
  run_step ln -sfn "$RUNTIME_PREFIX/bin/node" /usr/local/bin/node
}

# --- application ------------------------------------------------------------

install_application() {
  local bundle="$SOURCE_DIR/apps/daemon/dist/daemon.cjs"
  local cli="$SOURCE_DIR/apps/daemon/dist/way.cjs"
  local ui="$SOURCE_DIR/apps/ui/dist"

  [ -f "$bundle" ] || die "no bundle at $bundle — run 'pnpm build' first"

  run_step install -d -m 0755 "$PREFIX"
  # Beside the new one, before it lands. An update that replaces the only copy of a working daemon
  # has no way back, and the moment it is needed is the moment the device is hardest to reach.
  keep_previous_bundle
  run_step install -m 0755 "$bundle" "$PREFIX/daemon.cjs"
  [ -f "$bundle.map" ] && run_step install -m 0644 "$bundle.map" "$PREFIX/daemon.cjs.map"
  # The build stamp travels with the bundle: without it every device reports "built unknown", and
  # telling two deployments apart is exactly what it is for.
  [ -f "$(dirname "$bundle")/build.json" ] && run_step install -m 0644 "$(dirname "$bundle")/build.json" "$PREFIX/build.json"
  # The tunnel up-script, named by the generated OpenVPN unit. Shipped from the tree rather than
  # written by the daemon: it runs as root, under OpenVPN, on data the peer controls, so it belongs
  # with the code that is reviewed rather than with the files that are regenerated on every apply.
  if [ -f "$SOURCE_DIR/deploy/bin/tunnel-up" ]; then
    run_step install -d -m 0755 "$PREFIX/bin"
    run_step install -m 0755 "$SOURCE_DIR/deploy/bin/tunnel-up" "$PREFIX/bin/tunnel-up"
  fi

  # One wrapper, reached under two names, so `hostapd_cli` and `wpa_cli` typed by hand carry the
  # right `-p` without anybody remembering it. The real binaries are left exactly where they are and
  # keep their own names: this is installed beside them, never over them. The plan already prints a
  # warning about the flag, and an experienced operator ignored it six times in one evening — which
  # is the argument for a mechanism rather than a second warning.
  if [ -f "$SOURCE_DIR/deploy/bin/wayfarer-cli" ]; then
    run_step install -d -m 0755 "$PREFIX/bin"
    run_step install -m 0755 "$SOURCE_DIR/deploy/bin/wayfarer-cli" "$PREFIX/bin/wayfarer-cli"
    # Symbolic links rather than copies: the script dispatches on the name it was called by, so two
    # copies would be two things to keep in step for no gain.
    run_step ln -sfn "$PREFIX/bin/wayfarer-cli" /usr/local/bin/wayfarer-hostapd_cli
    run_step ln -sfn "$PREFIX/bin/wayfarer-cli" /usr/local/bin/wayfarer-wpa_cli
  fi

  if [ -f "$cli" ]; then
    run_step install -m 0755 "$cli" "$PREFIX/way.cjs"
    # The operator CLI is the same bundle with a different entry point.
    run_step tee /usr/local/bin/way >/dev/null <<EOF
#!/bin/sh
exec /usr/local/bin/node $PREFIX/way.cjs "\$@"
EOF
    run_step chmod 0755 /usr/local/bin/way
  fi

  if [ -d "$ui" ]; then
    run_step rm -rf "$PREFIX/ui"
    run_step install -d -m 0755 "$PREFIX/ui"
    run_step rsync -a --delete "$ui/" "$PREFIX/ui/"
  else
    warn "no interface build at $ui — the API will serve no static files"
  fi

  # 0700: the database holds password hashes, session ids and, later, profile secrets.
  run_step install -d -m 0700 "$STATE_DIR"
  run_step install -d -m 0750 "$CONFIG_DIR"

  if [ ! -f "$CONFIG_DIR/daemon.json" ]; then
    log "writing default $CONFIG_DIR/daemon.json (loopback, plus whatever the profile's surfaces resolve to)"
    if [ "$DRY_RUN" = 0 ]; then
      cat > "$CONFIG_DIR/daemon.json" <<'EOF'
{
  "listen": {
    "port": 8088,
    "addresses": ["127.0.0.1"],
    "interfaces": []
  }
}
EOF
      chmod 0640 "$CONFIG_DIR/daemon.json"
    fi
  else
    log "keeping existing $CONFIG_DIR/daemon.json"
  fi
}

# Units this project wrote into the administrator's directory before the location was corrected.
#
# Removed rather than left, and that is not tidiness: while a file sits at /etc/systemd/system/<unit> it
# both shadows the correct copy (that directory has the highest precedence) and blocks masking. A board
# upgraded from an older build would keep the defect with no sign of it.
migrate_units_out_of_etc() {
  local unit moved=0
  for unit in "$UNIT_NAME" wf-core.service wf-firewall.service wf-firewall-ready.target \
              wf-hostapd@.service wf-dhcp@.service wf-openvpn@.service wf-transport@.service \
              wf-socks@.service wf-supplicant@.service; do
    # Only a regular file, never a symlink: a symlink there is a mask or an enablement link the
    # administrator or systemd created, and neither is ours to remove.
    if [ -f "/etc/systemd/system/$unit" ] && [ ! -L "/etc/systemd/system/$unit" ]; then
      run_step rm -f "/etc/systemd/system/$unit"
      moved=$((moved + 1))
    fi
  done
  if [ "$moved" -gt 0 ]; then
    log "removed $moved unit file(s) this project had left in /etc/systemd/system"
    log "  that directory is the administrator's, and a file there makes 'systemctl mask' impossible"
    run_step systemctl daemon-reload
  fi
}

# Stops, disables and masks each unit in STOCK_UNITS_TO_MASK. Idempotent; a unit not installed is skipped.
#
# Masked persistently, not with --runtime: the race happens at boot, and a runtime mask is gone by then.
# Masked rather than only disabled: a mask survives something else calling `enable` — a package upgrade's
# maintainer script or a how-to followed on the device — which is the same reason the bench safety net
# masks rather than disables.
#
# Verified by result: `systemctl mask` is refused when a unit file sits at /etc/systemd/system/<unit>, and
# a warning is the only honest answer then. Undo, when the unit is wanted back:
#   systemctl unmask <unit> && systemctl enable --now <unit>
mask_conflicting_stock_units() {
  local entry unit reason load enablement
  for entry in "${STOCK_UNITS_TO_MASK[@]}"; do
    unit="${entry%%|*}"
    reason="${entry#*|}"
    # Existence from LoadState, never from is-enabled: a unit that does not exist answers is-enabled with
    # an error, and a package that is not installed is nothing to mask.
    load="$(systemctl show -p LoadState --value "$unit" 2>/dev/null || true)"
    if [ -z "$load" ] || [ "$load" = not-found ]; then
      continue
    fi
    enablement="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    if [ "$enablement" = masked ]; then
      log "kept $unit masked: $reason"
      continue
    fi
    if [ "$DRY_RUN" = 1 ]; then
      log "would stop, disable and mask $unit ($enablement): $reason"
      continue
    fi
    # Stopped first: a mask does not stop a running unit, and a stock server left running keeps the socket.
    systemctl disable --now "$unit" >/dev/null 2>&1 || warn "could not stop and disable $unit; masking it anyway"
    systemctl mask "$unit" >/dev/null 2>&1 || true
    enablement="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    if [ "$enablement" = masked ]; then
      log "masked $unit: $reason"
    else
      warn "could NOT mask $unit (is-enabled=$enablement): $reason"
      warn "  check for a unit file at /etc/systemd/system/$unit, which makes 'systemctl mask' impossible"
    fi
  done
}

install_unit() {
  run_step install -d -m 0755 "$UNIT_DIR"
  migrate_units_out_of_etc
  run_step install -m 0644 "$SOURCE_DIR/deploy/systemd/$UNIT_NAME" "$UNIT_DIR/$UNIT_NAME"
  # The journal cap is a RAM buffer size. It cannot cost anyone data they would otherwise
  # have kept, unlike redirecting where logs are stored, which is why it is applied even on
  # a shared machine while `Storage=` is left alone.
  run_step install -d -m 0755 /etc/systemd/journald.conf.d
  run_step install -m 0644 "$SOURCE_DIR/deploy/systemd/50-wayfarer-journal.conf" \
    /etc/systemd/journald.conf.d/50-wayfarer-journal.conf
  run_step systemctl daemon-reload
  run_step systemctl restart systemd-journald

  # Start first, verify it answers, and only then enable.
  #
  # This inverts the usual "enable before start" rule, and the inversion is deliberate rather than an
  # oversight — the two rules protect against different things and the difference is *which unit has
  # already been seen working*.
  #
  # "Enable before restart" is about a unit whose behaviour is already known: it stops a failing
  # restart from aborting a sequence and leaving the unit disabled, so the fault appears only after
  # the next reboot. That reasoning still holds and it is still what the reconciler does for the units
  # it manages.
  #
  # An installer is the other case. It is putting a **new** bundle on the device, and enabling before
  # verifying hands the next boot a service that has never once been observed to work. If that bundle
  # is broken, the device boots into it — with `Restart=always`, repeatedly — and the operator is left
  # with a board that fails the same way every time it is power-cycled. So: start it, ask it whether
  # it is alive, and enable only on the strength of the answer. A daemon that cannot answer is left
  # not-enabled, which is a device that boots clean and can be reached.
  run_step systemctl restart "$UNIT_NAME"

  if [ "$DRY_RUN" = 1 ]; then
    log "would verify the daemon answers, then enable $UNIT_NAME"
    return 0
  fi

  if daemon_answers; then
    run_step systemctl enable "$UNIT_NAME"
    # Verified by result, not by the exit code of the install: a unit that cannot be masked cannot be
    # rescued, and that is the property the safety net depends on. Checked here, once, where it is cheap.
    if [ "$DRY_RUN" = 0 ]; then
      if systemctl mask --runtime "$UNIT_NAME" >/dev/null 2>&1; then
        systemctl unmask --runtime "$UNIT_NAME" >/dev/null 2>&1
        log "verified: $UNIT_NAME can be masked, so the safety net can take it out of the boot path"
      else
        warn "$UNIT_NAME CANNOT be masked. The bench deadman cannot remove it from the boot path, so a"
        warn "  rescue would restore the network and hand the board straight back to this daemon."
        warn "  Check for a unit file left in /etc/systemd/system."
      fi
    fi
    local active enabled
    active="$(systemctl is-active "$UNIT_NAME" || true)"
    enabled="$(systemctl is-enabled "$UNIT_NAME" || true)"
    # Both, reported separately. A unit that is active and not enabled works now and is gone in the
    # morning, and one verdict covering both hides exactly the fault the check exists for.
    log "$UNIT_NAME is-active=$active is-enabled=$enabled"
    [ "$enabled" = enabled ] || warn "the daemon answered but could not be enabled; it will not start at boot"
    rollback_clear
    return 0
  fi

  warn "the daemon did not answer, so it has deliberately NOT been enabled: this device will boot"
  warn "  without it rather than boot into a service that has never been seen to work."
  journalctl -u "$UNIT_NAME" -n 30 --no-pager >&2 || true
  rollback_to_previous
  return 1
}

# --- the bundle we can go back to -------------------------------------------

# The previous bundle, kept beside the current one rather than overwritten.
#
# An update that replaces the only copy of a working daemon has no way back, and the moment it is
# needed is the moment the device is hardest to reach. Keeping one previous copy costs a few
# megabytes on a card with tens of gigabytes free.
PREVIOUS_SUFFIX=.previous

keep_previous_bundle() {
  # Called before the new bundle lands. A missing current bundle is a first install, not a failure.
  [ -f "$PREFIX/daemon.cjs" ] || return 0

  # An existing rollback copy is NEVER overwritten, and that is the whole point of this branch.
  #
  # Its presence means a previous update started and never reached the line that clears it — the
  # installer was interrupted, the device lost power, somebody pressed ctrl-c. The bundle sitting in
  # place is therefore the one that failed, and copying it over the rollback would destroy the last
  # copy of a daemon that was known to work, using the broken one as its replacement. The second
  # attempt would then have nothing to go back to, at exactly the moment a second attempt is being made
  # because the first went wrong.
  #
  # The general rule, recorded in docs/06: the record of how to undo something must not be stored where
  # the thing being undone can overwrite it.
  if [ -f "$PREFIX/daemon.cjs$PREVIOUS_SUFFIX" ]; then
    warn "a rollback copy from an earlier update is still here, so this update keeps it rather than"
    warn "  replacing it: it is the last bundle this device is known to have run."
    return 0
  fi

  run_step cp -a "$PREFIX/daemon.cjs" "$PREFIX/daemon.cjs$PREVIOUS_SUFFIX"
  [ -f "$PREFIX/way.cjs" ] && run_step cp -a "$PREFIX/way.cjs" "$PREFIX/way.cjs$PREVIOUS_SUFFIX"
  return 0
}

rollback_clear() {
  # The new bundle answered, so the copy is no longer a fallback — it is just an old file that the
  # next reader would have to work out the status of.
  rm -f "$PREFIX/daemon.cjs$PREVIOUS_SUFFIX" "$PREFIX/way.cjs$PREVIOUS_SUFFIX"
}

rollback_to_previous() {
  if [ ! -f "$PREFIX/daemon.cjs$PREVIOUS_SUFFIX" ]; then
    warn "no previous bundle to fall back to; the daemon stays installed and not enabled"
    return 0
  fi
  warn "restoring the previous bundle"
  mv "$PREFIX/daemon.cjs$PREVIOUS_SUFFIX" "$PREFIX/daemon.cjs"
  [ -f "$PREFIX/way.cjs$PREVIOUS_SUFFIX" ] && mv "$PREFIX/way.cjs$PREVIOUS_SUFFIX" "$PREFIX/way.cjs"
  sync
  systemctl restart "$UNIT_NAME" || true

  if daemon_answers; then
    # The previous bundle works, so it is the one that should be running at the next boot. Leaving it
    # installed but not enabled would mean a device that recovers now and comes up dead later.
    systemctl enable "$UNIT_NAME" || warn "could not enable the restored daemon"
    warn "the previous bundle is running and enabled; the new one was not installed"
  else
    warn "the previous bundle did not answer either; leaving the daemon not enabled"
  fi
}

# Whether the daemon is answering on its own port, asked of the daemon rather than of systemd.
#
# `is-active` says a process exists. It does not say the process is serving, and the difference is
# the whole point of verifying at all: a daemon that starts, fails to bind and sits there is `active`.
daemon_answers() {
  local port listen_json
  listen_json="$(/usr/local/bin/way listen --json 2>/dev/null || true)"
  port="$(printf '%s' "$listen_json" | sed -n 's/.*"port":[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
  port="${port:-8088}"

  # Up to ten seconds, asked repeatedly: start-up includes opening a database and running migrations,
  # and a single immediate probe would report a healthy daemon as dead purely by being early.
  local attempt=0
  while [ "$attempt" -lt 10 ]; do
    # curl where it exists, wget where it does not. Neither is in the required set — the daemon does
    # not need them — so a device with only one must still be able to verify an install.
    if command -v curl >/dev/null 2>&1; then
      curl -fsS --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 2 -O /dev/null "http://127.0.0.1:$port/api/health" && return 0
    else
      warn "neither curl nor wget is present, so the daemon cannot be verified before being enabled"
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

# --- host settings ----------------------------------------------------------

apply_host_settings() {
  if [ "$SKIP_HOST_SETTINGS" = 1 ]; then
    log "skipping host settings (--skip-host-settings): the kernel command line and the"
    log "  filesystem check interval are unchanged. On a device with no console, set them"
    log "  before relying on it unattended."
    return
  fi

  # The default repair mode fixes only what is unconditionally safe and stops to ask a
  # human for anything else. On a board with no console and no serial port that is an
  # unbootable device, recoverable only by removing the card.
  "$SOURCE_DIR/deploy/set-fsck-repair.sh" || warn "could not set the unattended repair option"

  # A periodic check interval, which cannot affect booting and is therefore applied even
  # where the command line is not.
  local root_device
  root_device="$(findmnt -no SOURCE / || true)"
  if [ -n "$root_device" ] && command -v tune2fs >/dev/null; then
    run_step tune2fs -c 30 "$root_device" >/dev/null || warn "tune2fs failed on $root_device"
    log "filesystem check interval set to 30 mounts on $root_device"
  fi
}

# --- credentials ------------------------------------------------------------

print_next_steps() {
  # What this prints has to match what the software actually does today. The first version told the
  # operator to join an access point this slice does not create and to log in as a user the schema
  # has no field for — and a correctly installed board that looks broken produces the worst bug
  # reports there are.
  local port addresses interfaces listen_json
  # Asked of the daemon's own configuration loader rather than read out of the JSON file, because
  # the loader is where the merge happens: it always adds loopback, clamps an out-of-range port and
  # falls back to defaults on a malformed file. Parsing the file here produced a message that did
  # not match what the software was doing — which is the one thing this message must never do.
  listen_json="$(/usr/local/bin/way listen --json 2>/dev/null || true)"
  if [ -n "$listen_json" ]; then
    port="$(printf '%s' "$listen_json" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
    # `boundAddresses`, not `addresses`. The second is the configured block — on a fresh install that
    # is loopback and nothing — and printing it described every new board as unreachable except over
    # SSH, while the panel was already answering on the wire. The first is what the bind policy
    # resolves against the interfaces the kernel reports, which is what the daemon actually opens.
    addresses="$(printf '%s' "$listen_json" | sed -n 's/.*"boundAddresses":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ')"
    interfaces="$(printf '%s' "$listen_json" | sed -n 's/.*"boundInterfaces":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ')"
    # An older daemon has no such keys. Falling back to the configured block is wrong-but-narrow;
    # printing nothing at all is worse, so it falls back and the message below never claims the list
    # is complete.
    if [ -z "${addresses// /}" ]; then
      addresses="$(printf '%s' "$listen_json" | sed -n 's/.*"addresses":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ')"
    fi
  else
    # The CLI could not answer — say so rather than guessing from the file and being wrong again.
    warn "could not ask the daemon where it listens; check with: way listen"
    port="?"
    addresses="see $CONFIG_DIR/daemon.json"
    interfaces=""
  fi

  cat <<EOF

Wayfarer is installed and running.

Reachable on:      ${addresses:-127.0.0.1} port $port
EOF
  if [ -n "${interfaces// /}" ]; then
    # Naming the interfaces, not adding to the list: their addresses are already in it. The old
    # wording said "plus the current addresses of", which described the same sockets twice.
    printf '                   those being loopback and: %s\n' "$interfaces"
  fi
  printf '%s\n' "                   The wire is bound without waiting for a profile: it is the interface
                   no plan touches, so a board is reachable over Ethernet from the moment
                   it boots. Once you apply a profile with an access point, the panel
                   answers on that too, and on the network this device is a client of
                   unless you turn that off in the profile. No tunnel is ever bound, under
                   any profile — that one is a prohibition, not a setting.

                   The list above is a reading taken just now, not a report from the
                   running daemon. What is actually open:
                     ss -tln | grep :$port
                   If that shows loopback alone — which is what happens when the driver
                   could not be asked which interfaces are radios, because an ether link
                   is then left unclassified rather than guessed at — reach it over SSH:
                     ssh -L $port:127.0.0.1:$port <this device>
                   then open http://127.0.0.1:$port"

  cat <<EOF

Sign in with the password below — there is no user name, the device has one operator.

  password: adminpass

Nothing forces you to change it, and nothing is refused until you do. It is published
documentation, so until you do change it anyone who can reach this device's access point
or the network it is plugged into can sign in. Change it from the interface when you are
ready; it cannot be set back to this value afterwards.

Two commands are installed for driving the radios by hand. Use these rather than
hostapd_cli and wpa_cli directly — this device keeps its control sockets to itself, and
the plain tools report a working access point as absent when pointed at the wrong one:

  wayfarer-hostapd_cli -i <ap interface> status
  wayfarer-wpa_cli -i <uplink interface> status

This release configures nothing on the network: no access point, no uplink, no firewall
rules and no tunnels. It reads the hardware and reports it. Whatever is serving your
network now keeps doing so — except the distribution units listed as masked above, which
contend with this device's own access-point services. Undo one with:
  systemctl unmask <unit> && systemctl enable --now <unit>
EOF
}

main() {
  check_prerequisites
  [ "$INSTALL_RUNTIME" = 1 ] && install_runtime
  install_application
  # Before the daemon starts, so its first drift round already reads the units masked.
  mask_conflicting_stock_units

  # The exit status is carried rather than allowed to abort, so the host settings and the closing
  # summary still run on a device whose daemon did not come up. An installer that stops talking at the
  # moment something went wrong leaves the operator with less information than one that finishes and
  # says what is wrong — and the non-zero exit is what automation reads anyway.
  local unit_ok=1
  install_unit || unit_ok=0

  apply_host_settings
  print_next_steps

  if [ "$unit_ok" = 0 ]; then
    warn "install finished with the daemon NOT enabled. Read the log above, fix what it names, and"
    warn "  re-run this installer: it is idempotent and a second run costs nothing."
    return 1
  fi
  return 0
}

main "$@"
