#!/bin/bash
# Set the kernel command line so a filesystem check at boot repairs without asking.
#
# Why this is a host setting and not something the daemon does: the default repair mode
# fixes only what is unconditionally safe and **stops to ask a human** for anything else.
# On a board with no console and no serial port that is an unbootable device, recoverable
# only by removing the memory card — and the daemon cannot fix a machine that never
# reaches user space.
#
# The option added is `fsck.repair=yes`.
#
# Idempotent: a second run on a file that already carries the option changes nothing, so
# the installer can be re-run. Takes the file to edit as an argument so it can be tested
# against copies rather than against a real boot configuration.
#
# Usage: set-fsck-repair.sh [file]
#        set-fsck-repair.sh --check [file]     report state, change nothing (exit 0 when set)

set -euo pipefail

OPTION="fsck.repair=yes"
CHECK_ONLY=0

if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
  shift
fi

TARGET="${1:-}"

find_target() {
  # Armbian and other u-boot images keep extra kernel arguments in armbianEnv.txt; the
  # Raspberry Pi family uses cmdline.txt. Anything else (GRUB, systemd-boot) is reported
  # rather than edited, because a wrong edit there is a device that does not boot and the
  # person holding it may not have a card reader.
  for candidate in /boot/armbianEnv.txt /boot/firmware/armbianEnv.txt /boot/cmdline.txt /boot/firmware/cmdline.txt; do
    if [ -f "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if [ -z "$TARGET" ]; then
  if ! TARGET="$(find_target)"; then
    cat >&2 <<EOF
set-fsck-repair: no supported boot configuration file found.
Add "$OPTION" to the kernel command line by hand. Without it, a filesystem check at boot
can stop and wait for a human on a device that has no console.
EOF
    exit 2
  fi
fi

[ -f "$TARGET" ] || { printf 'set-fsck-repair: %s does not exist\n' "$TARGET" >&2; exit 2; }

case "$(basename "$TARGET")" in
  armbianEnv.txt) STYLE=keyvalue ;;
  cmdline.txt) STYLE=flat ;;
  *) STYLE=keyvalue ;;
esac

# Word membership is tested in the shell rather than with a regular expression. An anchor inside a
# group — `([[:space:]]|$)` — is a GNU extension: BSD grep does not treat it as an end-of-line
# anchor, so the same script reported "not set" on a file that already carried the option when run
# on a development machine and "set" on the board. Splitting on whitespace has no such difference.
already_set() {
  local words word
  if [ "$STYLE" = keyvalue ]; then
    words="$(sed -n 's/^extraargs=//p' "$TARGET" | tail -1)"
  else
    words="$(head -1 "$TARGET")"
  fi
  for word in $words; do
    [ "$word" = "$OPTION" ] && return 0
  done
  return 1
}

if already_set; then
  printf 'set-fsck-repair: %s already carries %s\n' "$TARGET" "$OPTION"
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  printf 'set-fsck-repair: %s does NOT carry %s\n' "$TARGET" "$OPTION"
  exit 1
fi

# Written through a temporary file in the same directory, then renamed: /boot is the one
# filesystem where a truncated file costs a trip to fetch the card.
TMP="$(mktemp "$(dirname "$TARGET")/.$(basename "$TARGET").XXXXXX")"
trap 'rm -f "$TMP"' EXIT

if [ "$STYLE" = keyvalue ]; then
  if grep -qE '^extraargs=' "$TARGET"; then
    # Append to the existing line rather than adding a second one: the loader reads the
    # last definition only, so a second line silently discards the first.
    sed -E "s|^extraargs=(.*)$|extraargs=\1 ${OPTION}|" "$TARGET" > "$TMP"
  else
    cat "$TARGET" > "$TMP"
    printf 'extraargs=%s\n' "$OPTION" >> "$TMP"
  fi
else
  # cmdline.txt is a single line; appending a newline breaks some loaders.
  awk -v opt="$OPTION" 'NR==1 {printf "%s %s\n", $0, opt; next} {print}' "$TARGET" > "$TMP"
fi

chmod --reference="$TARGET" "$TMP" 2>/dev/null || chmod 0644 "$TMP"
sync "$TMP"
mv "$TMP" "$TARGET"
trap - EXIT
sync

printf 'set-fsck-repair: added %s to %s (takes effect at the next boot)\n' "$OPTION" "$TARGET"
