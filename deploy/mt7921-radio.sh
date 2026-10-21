#!/bin/bash
# Change how an mt7921 (MT7961) USB radio runs, one setting at a time, or take it back.
#
# Why this exists: on the bench board the adapter stops sending beacons for 15–120 s at a
# time while data keeps flowing, and re-sending the beacon template does not end a stall
# (docs/18-usb-adapter-return.md). The candidates left change the radio itself, and each
# is tried alone so a result can be attributed:
#
# firmware: a pinned newer linux-firmware build. The files go to /lib/firmware/updates,
#           which the kernel searches before /lib/firmware and no package owns, so a
#           firmware package upgrade neither overwrites them nor is overwritten by them.
#           Removing them restores the distribution's firmware.
# sg:       `disable_usb_sg=1` on mt76_usb, which makes the driver send each frame as one
#           USB buffer instead of a scatter-gather list. Set in /etc/modprobe.d so it
#           survives a reboot; removing the file restores the default.
#
# Both are read only when the driver loads, so every action reloads it, down to mt76_usb:
# a dry run (`modprobe -r -n -v mt7921u`) lists only mt7921u itself, so whether its
# now-unused dependencies follow was not relied on. That drops the interface, and the access point units are bound to the
# interface and stop with it; nothing restarts them when it comes back, so this script
# does. The ssh session that started it may be riding that very access point — run it
# detached (systemd-run) so the reload and the fallback finish regardless.
#
# Each "on" action reloads and waits for the access point. If it is not ENABLED within
# the deadline, the change is undone and the driver reloaded again.
#
# Usage: mt7921-radio.sh firmware-install|firmware-remove|sg-disable|sg-restore <ap-interface>

set -euo pipefail

COMMIT=ced02591a80209ece29604db57ee87126293a3f0   # linux-firmware, 2026-03-13, build 20260224
BASE="https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/plain/mediatek"
DEST=/lib/firmware/updates/mediatek
SG_CONF=/etc/modprobe.d/wayfarer-mt76-usb.conf
HOSTAPD_CTRL=/run/wayfarer/hostapd
declare -A SHA256=(
  [WIFI_RAM_CODE_MT7961_1.bin]=b94217a951518a9c14095765f367bc5dd7698f2dc033941d6f18fc2ebd6a2ab9
  [WIFI_MT7961_patch_mcu_1_2_hdr.bin]=a276c06c2b772adb50b86639d33c82824ff4c21d617feb78caea74c040b873f6
)
USAGE="usage: $0 firmware-install|firmware-remove|sg-disable|sg-restore <ap-interface>"

ACTION="${1:-}"
IFACE="${2:-}"
[ -n "$ACTION" ] && [ -n "$IFACE" ] || { echo "$USAGE" >&2; exit 2; }

log() { printf '[mt7921-radio] %s\n' "$*"; logger -t mt7921-radio -- "$*" 2>/dev/null || true; }

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
  modprobe -r mt792x_usb mt76_usb 2>/dev/null || true
  modprobe "$MODULE"
  for i in $(seq 30); do [ -e "/sys/class/net/$IFACE" ] && break; sleep 1; done
  [ -e "/sys/class/net/$IFACE" ] || { log "$IFACE did not come back"; return 1; }
  systemctl reset-failed "wf-hostapd@$IFACE" "wf-dhcp@$IFACE" 2>/dev/null || true
  systemctl start "wf-hostapd@$IFACE" "wf-dhcp@$IFACE" || true
  for i in $(seq 30); do ap_enabled && break; sleep 1; done
  ap_enabled || { log "access point on $IFACE is not ENABLED"; return 1; }
  log "access point on $IFACE is ENABLED;" \
      "$(dmesg | grep -o 'WM Firmware Version.*' | tail -1);" \
      "disable_usb_sg=$(cat /sys/module/mt76_usb/parameters/disable_usb_sg)"
}

# Apply a change, reload, and undo the change if the access point does not come back.
try() {
  local undo="$1"
  if ! reload; then
    log "undoing: $undo"
    "$undo"
    reload
    exit 1
  fi
}

sg_unset() { rm -f "$SG_CONF"; }

case "$ACTION" in
  firmware-install)
    fetch
    log "placed firmware from linux-firmware $COMMIT in $DEST"
    try unplace
    ;;
  firmware-remove)
    unplace
    log "removed firmware from $DEST"
    reload
    ;;
  sg-disable)
    printf '# docs/18-usb-adapter-return.md: tried against beacon stalls on the access point radio.\noptions mt76_usb disable_usb_sg=1\n' > "$SG_CONF"
    log "wrote $SG_CONF"
    try sg_unset
    ;;
  sg-restore)
    sg_unset
    log "removed $SG_CONF"
    reload
    ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
