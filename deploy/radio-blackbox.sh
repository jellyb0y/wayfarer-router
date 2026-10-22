#!/bin/bash
# A flight recorder for a USB access point radio: what the radio and its USB link did in the
# minutes before it went silent, kept so the next hang can be told apart.
#
# Why this exists: on 2026-10-22 at 19:28:50 the mt7921u adapter stopped receiving while its
# device stayed on the bus, and the kernel said nothing until 19:34:10 (docs/18-usb-adapter-
# return.md). Two explanations fit what was logged: the chip's firmware stopped answering, or
# the board's USB host stopped asking. Only the USB traffic itself separates them — requests the
# host submitted that the device never completed, or no requests at all — and that is gone by
# the time anyone looks. So it is recorded all the time, in memory, and kept only when it matters.
#
# What it keeps, all under /run (tmpfs, memory), overwritten in a ring:
#   samples   one line a second: interface counters, the USB device's URB count, the driver's
#             host-side queues, the radio's temperature, and every client's inactivity and signal.
#             Two files of SAMPLE_LINES, so between one and two hours.
#   usbmon    the text trace of the radio's USB bus, in chunks of USB_LINES; the newest USB_CHUNKS
#             are kept. Measured on 2026-10-22 with five clients: about 1700 trace lines a second,
#             so a chunk (about 2.9 MB) is 23 s and the ring holds the last minute and a half.
#
# Nothing touches the card until the radio goes silent: clients listed and no packet received for
# SILENT_S seconds. That is shorter than the radio watch's minute, so the record is taken before
# the watch restarts the access point. A second record is taken once packets flow again, so the
# repair is in it too. Each record is one .tgz under STORE; the newest KEEP are kept, none older than
# MAX_AGE_DAYS, and no more than MAX_STORE_KB in all. A silence within MIN_GAP_S of the last record
# is not recorded, so the card sees at most two records in ten minutes.
#
# Only host-side driver files are read (`xmit-queues`, `rx-queues`). Files such as `acq` and
# `tx_stats` read the chip's registers, and reading a hung chip is the one thing a recorder must
# not do: it can be what sets off the driver's reset, which would change the event being recorded.
#
# Usage: radio-blackbox.sh install|remove <ap-interface>
#        radio-blackbox.sh run <ap-interface>      (what the unit runs)

set -euo pipefail

SELF=/usr/local/sbin/wayfarer-radio-blackbox
UNIT=wayfarer-radio-blackbox.service
MODULES_CONF=/etc/modules-load.d/wayfarer-usbmon.conf
RING=/run/wayfarer-blackbox
STORE=/var/lib/wayfarer/blackbox
HOSTAPD_CTRL=/run/wayfarer/hostapd
SAMPLE_LINES=3600
USB_LINES=40000
USB_CHUNKS=4
SILENT_S=20
KEEP=20
# A radio that flaps would otherwise write a record every minute, all day, to a card that wears out.
MIN_GAP_S=600
MAX_AGE_DAYS=14
MAX_STORE_KB=$((200 * 1024))
USAGE="usage: $0 install|remove|run <ap-interface>"

[ $# -eq 2 ] || { echo "$USAGE" >&2; exit 2; }
ACTION=$1 IF=$2
case $IF in *[!A-Za-z0-9_.-]*|'') echo "bad interface name: $IF" >&2; exit 2;; esac

do_install() {
  [ -e "/sys/class/net/$IF/device" ] || { echo "$IF has no device" >&2; exit 1; }
  install -m 0755 "$0" "$SELF"
  echo usbmon > "$MODULES_CONF"
  modprobe usbmon
  cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Wayfarer flight recorder for the access point radio on $IF

[Service]
ExecStart=$SELF run $IF
Restart=always
RestartSec=10
Nice=10
# The ring is sized well under this; the cap is there so a runaway cannot take the board's memory.
MemoryMax=64M

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$UNIT"
  systemctl --no-pager --lines=0 status "$UNIT"
}

do_remove() {
  systemctl disable --now "$UNIT" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT" "$MODULES_CONF" "$SELF"
  systemctl daemon-reload
  rm -rf "$RING"
  # The usbmon module is left loaded: unloading it while nothing reads it gains nothing, and the
  # next boot no longer loads it. The records under $STORE are kept; they are the point.
  echo "removed; records kept in $STORE"
}

usb_device() {
  # The interface's device is the USB interface (2-1:1.0); its parent is the USB device (2-1).
  readlink -f "/sys/class/net/$IF/device/.."
}

sample() {
  local s=/sys/class/net/$IF/statistics dev mt hw temp sta
  dev=$(usb_device)
  mt=/sys/kernel/debug/ieee80211/$(basename "$(readlink "/sys/class/net/$IF/phy80211")")/mt76
  temp=-
  for hw in /sys/class/net/$IF/phy80211/hwmon*/temp1_input; do [ -r "$hw" ] && temp=$(<"$hw"); done
  sta=$(timeout 3 hostapd_cli -p "$HOSTAPD_CTRL" -i "$IF" all_sta 2>/dev/null |
    awk -F= '/^[0-9a-f][0-9a-f]:/{m=substr($0,1,8)} $1=="inactive_msec"{i[m]=$2} $1=="signal"{g[m]=$2}
      END{for(m in i) printf "%s/%s/%s ", m, i[m], g[m]}')
  printf '%s rx=%s tx=%s rxb=%s txb=%s txe=%s rxd=%s urb=%s temp=%s q=%s rq=%s sta=[%s]\n' \
    "$(date +%s.%N | cut -c1-14)" "$(<$s/rx_packets)" "$(<$s/tx_packets)" "$(<$s/rx_bytes)" "$(<$s/tx_bytes)" \
    "$(<$s/tx_errors)" "$(<$s/rx_dropped)" "$(cat "$dev/urbnum" 2>/dev/null || echo -)" "$temp" \
    "$(timeout 2 awk -F'|' 'NR>1{gsub(/ /,""); printf "%s:%s/%s/%s,", $1, $2, $3, $4}' "$mt/xmit-queues" 2>/dev/null)" \
    "$(timeout 2 awk -F'|' 'NR>1{gsub(/ /,""); printf "%s:%s/%s/%s,", $1, $2, $3, $4}' "$mt/rx-queues" 2>/dev/null)" "$sta"
}

record() {
  local why=$1 name
  name=$(date +%Y%m%dT%H%M%S)-$why
  mkdir -p "$STORE" "$RING/$name"
  journalctl -k --since=-15min --no-pager -o short-precise > "$RING/$name/kernel.txt" 2>&1 || true
  journalctl -u "wf-hostapd@$IF" -u wayfarer --since=-15min --no-pager -o short-precise > "$RING/$name/units.txt" 2>&1 || true
  timeout 3 hostapd_cli -p "$HOSTAPD_CTRL" -i "$IF" status > "$RING/$name/hostapd-status.txt" 2>&1 || true
  # Copies, not the live files: the writers keep appending while tar reads.
  cp "$RING"/samples.* "$RING/$name/" 2>/dev/null || true
  cp "$RING"/usb.* "$RING/$name/" 2>/dev/null || true
  tar -C "$RING" -czf "$STORE/$name.tgz" "$name"
  rm -rf "${RING:?}/$name"
  prune
  echo "recorded $STORE/$name.tgz ($why)"
}

# Run after every record and once an hour, so the store stays bounded by count, by age and by size
# whatever happened to the radio and however long this runs.
prune() {
  [ -d "$STORE" ] || return 0
  ls -1t "$STORE"/*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  find "$STORE" -maxdepth 1 -name '*.tgz' -mtime +"$MAX_AGE_DAYS" -delete
  while [ "$(du -sk "$STORE" | cut -f1)" -gt "$MAX_STORE_KB" ]; do
    oldest=$(ls -1tr "$STORE"/*.tgz 2>/dev/null | head -1)
    [ -n "$oldest" ] || break
    rm -f "$oldest"
  done
}

run() {
  mkdir -p "$RING"
  rm -f "$RING"/usb.* "$RING"/samples.*
  modprobe usbmon
  local bus trace
  bus=$(cat "$(usb_device)/busnum")
  trace=/sys/kernel/debug/usb/usbmon/${bus}u
  [ -r "$trace" ] || { echo "no usbmon trace at $trace" >&2; exit 1; }

  # The trace: split writes fixed-size chunks; the loop below drops all but the newest.
  ( cd "$RING" && exec split -l "$USB_LINES" -a 6 -d - usb. < "$trace" ) &
  local tracer=$! last_rx=-1 still=0 armed=1 recovered_at=0 last_record=0 n=0 file now rx clients
  trap 'kill $tracer 2>/dev/null' EXIT

  while kill -0 $tracer 2>/dev/null; do
    file=$RING/samples.$(( (n / SAMPLE_LINES) % 2 ))
    [ $((n % SAMPLE_LINES)) -eq 0 ] && : > "$file"
    line=$(sample) || line="$(date +%s) sample failed"
    echo "$line" >> "$file"
    n=$((n + 1))

    ls -1 "$RING"/usb.* 2>/dev/null | head -n -"$USB_CHUNKS" | xargs -r rm -f

    rx=$(<"/sys/class/net/$IF/statistics/rx_packets") || rx=-1
    clients=$(sed -n 's/.*sta=\[\(.*\)\]/\1/p' <<<"$line" | wc -w)
    now=$(date +%s)
    if [ "$rx" = "$last_rx" ] && [ "$clients" -gt 0 ]; then still=$((still + 1)); else still=0; fi
    if [ $armed -eq 1 ] && [ $still -ge $SILENT_S ] && [ $((now - last_record)) -ge $MIN_GAP_S ]; then
      record silent || true
      armed=0 last_record=$now
    elif [ $armed -eq 0 ] && [ "$rx" != "$last_rx" ]; then
      [ $recovered_at -eq 0 ] && recovered_at=$now
      # Thirty seconds after packets flow again, so the clients' return is in the record too.
      if [ $((now - recovered_at)) -ge 30 ]; then
        record recovered || true
        armed=1 recovered_at=0
      fi
    fi
    last_rx=$rx
    [ $((n % 3600)) -eq 0 ] && prune
    sleep 1
  done
  echo "the usbmon reader stopped" >&2
  exit 1
}

case $ACTION in
  install) do_install ;;
  remove) do_remove ;;
  run) run ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
