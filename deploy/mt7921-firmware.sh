#!/bin/bash
# Install a pinned newer firmware for an mt7921 (MT7961) USB radio, or take it away again.
#
# Why this exists: the firmware shipped by the distribution on the bench board (build
# 20230526) stops sending beacons for 15–120 s at a time while data keeps flowing, and
# re-sending the beacon template does not end a stall (docs/18-usb-adapter-return.md).
# A newer firmware is the one candidate that changes what the radio itself does.
#
# Where the files go: /lib/firmware/updates is searched by the kernel before
# /lib/firmware, and no package owns it, so a firmware package upgrade neither
# overwrites these files nor is overwritten by them. Removing them restores the
# distribution's firmware.
#
# Firmware is read only when the driver probes, so both actions reload the driver. That
# drops the interface, and the access point units are bound to the interface and stop
# with it; nothing restarts them on their own when it comes back, so this script does.
# The ssh session that started it may be riding that very access point — run it detached
# (systemd-run) so the reload and the fallback finish regardless.
#
# install: place the files, reload, wait for the access point. If it is not ENABLED
#          within the deadline, remove the files and reload again.
# remove:  remove the files and reload.
#
# Usage: mt7921-firmware.sh install|remove <ap-interface>

set -euo pipefail

COMMIT=ced02591a80209ece29604db57ee87126293a3f0   # linux-firmware, 2026-03-13, build 20260224
BASE="https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/mediatek"
DEST=/lib/firmware/updates/mediatek
HOSTAPD_CTRL=/run/wayfarer/hostapd
declare -A SHA256=(
  [WIFI_RAM_CODE_MT7961_1.bin]=b94217a951518a9c14095765f367bc5dd7698f2dc033941d6f18fc2ebd6a2ab9
  [WIFI_MT7961_patch_mcu_1_2_hdr.bin]=a276c06c2b772adb50b86639d33c82824ff4c21d617feb78caea74c040b873f6
)

ACTION="${1:-}"
IFACE="${2:-}"
[ -n "$ACTION" ] && [ -n "$IFACE" ] || { echo "usage: $0 install|remove <ap-interface>" >&2; exit 2; }

log() { printf '[mt7921-firmware] %s\n' "$*"; logger -t mt7921-firmware -- "$*" 2>/dev/null || true; }

# The module is read from the interface rather than named here, so the script refuses to
# reload anything that is not the radio it was pointed at.
MODULE="$(basename "$(readlink -f "/sys/class/net/$IFACE/device/driver/module")")"
case "$MODULE" in
  mt7921u) ;;
  *) echo "$IFACE is driven by '$MODULE', not mt7921u; refusing" >&2; exit 2 ;;
esac

fetch() {
  local tmp f
  tmp="$(mktemp -d /tmp/wayfarer-fw-XXXXXX)"
  for f in "${!SHA256[@]}"; do
    if ! curl -fsS --max-time 60 -A wayfarer-install -o "$tmp/$f" "$BASE/$f?id=$COMMIT" ||
       ! echo "${SHA256[$f]}  $tmp/$f" | sha256sum -c --quiet -; then
      log "could not fetch $f at $COMMIT with the pinned checksum"
      rm -rf "$tmp"; return 1
    fi
  done
  # Both files or neither: the patch and the RAM code are released as a pair.
  install -d "$DEST"
  for f in "${!SHA256[@]}"; do install -m 0644 "$tmp/$f" "$DEST/$f"; done
  rm -rf "$tmp"
}

unplace() {
  local f
  for f in "${!SHA256[@]}"; do rm -f "$DEST/$f"; done
}

ap_enabled() {
  hostapd_cli -p "$HOSTAPD_CTRL" -i "$IFACE" status 2>/dev/null | grep -qx 'state=ENABLED'
}

reload() {
  local i
  modprobe -r "$MODULE"
  modprobe "$MODULE"
  for i in $(seq 30); do [ -e "/sys/class/net/$IFACE" ] && break; sleep 1; done
  [ -e "/sys/class/net/$IFACE" ] || { log "$IFACE did not come back"; return 1; }
  systemctl reset-failed "wf-hostapd@$IFACE" "wf-dhcp@$IFACE" 2>/dev/null || true
  systemctl start "wf-hostapd@$IFACE" "wf-dhcp@$IFACE" || true
  for i in $(seq 30); do ap_enabled && break; sleep 1; done
  ap_enabled || { log "access point on $IFACE is not ENABLED"; return 1; }
  log "access point on $IFACE is ENABLED; $(dmesg | grep -o 'WM Firmware Version.*' | tail -1)"
}

case "$ACTION" in
  install)
    fetch
    log "placed firmware from linux-firmware $COMMIT in $DEST"
    if ! reload; then
      log "falling back to the distribution firmware"
      unplace
      reload
      exit 1
    fi
    ;;
  remove)
    unplace
    log "removed firmware from $DEST"
    reload
    ;;
  *) echo "usage: $0 install|remove <ap-interface>" >&2; exit 2 ;;
esac
