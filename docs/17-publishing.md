# 17. Publishing

What has to be true before this repository is made public, written as checks somebody can run rather
than as things to remember.

## The three that are not about tidiness

### 1. No secret has ever been committed

A secret removed in a later commit is still in the history, and a published history is permanent.

```sh
# Every string that looks like a credential, across all of history.
git log -p --all | grep -nEi \
  '(passphrase|password|psk|token|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY)[^a-z]' \
  | grep -vE 'wayfarer|bench-only|DEFAULT_PASSWORD|placeholder|example' | head -50
```

Known and intentional:

* `wayfarer` — the documented first-boot password, which the device refuses to operate with until it is
  changed. It is printed by the installer on purpose.
* `bench-only-not-a-secret` — the bench board's password, named so that finding it in a log is
  self-explanatory.
* `vintage123` — the bench wireless passphrase, for a network that exists in one room.

Anything else is a finding. Rewriting history is the only fix, and it is easier before the first push
than after.

### 2. Nothing refers to any other project

This repository is meant to be read by people with no access to anything else, and a dangling reference
is worse than no reference. There must be no "as in the old version", no "ported from", no path outside
this tree, no name of another repository.

```sh
# Paths that leave the tree, in tracked files.
git grep -nE '(/Users/|/home/[a-z]+/|~/[A-Za-z])' -- . \
  ':!*.md' ':!scripts/*' ':!deploy/*' | head -20
```

Absolute paths are legitimate in the deploy scripts and in documented commands, where they name the
*device's* filesystem. They are not legitimate in source.

### 3. Every number carries its window

The claim this project makes about itself is that it states what it measured. One estimate presented as
a measurement undoes it. Before publishing, read [09-stack](09-stack.md) and
[12-hardware-invariants](12-hardware-invariants.md) and check that every figure says where it came from —
including the ones that are inconveniently short.

The README's **State of the evidence** section is the front-matter version of this and must match what
the numbered documents say. If they disagree, the README is the one that will be believed.

## The mechanical checks

```sh
pnpm install
pnpm typecheck        # all five packages
pnpm test             # no hardware required
pnpm build
```

```sh
# Nothing untracked that should have been ignored, and nothing ignored that should be tracked.
git status --porcelain
git check-ignore -v CLAUDE.md          # local working rules: must be ignored
```

```sh
# Every documentation link resolves.
for f in docs/*.md README.md; do
  grep -oE '\]\((docs/)?[0-9A-Za-z._/-]+\.md' "$f" | sed 's/^](//' | while read -r target; do
    case "$target" in docs/*) p="$target" ;; *) p="$(dirname "$f")/$target" ;; esac
    [ -f "$p" ] || echo "$f -> $target MISSING"
  done
done
```

## What must be in place

| | |
|---|---|
| `LICENSE` | MIT, at the root |
| `README.md` | with **State of the evidence**, and no adjective standing where a measurement should be |
| `CLAUDE.md` | gitignored — it is local working rules, not documentation |
| no progress or handover files | folded into the numbered documents and deleted |

## What must not be in the README

Checked by reading, because no grep catches a tone:

* **Not** production-ready, battle-tested, robust, or any uptime claim.
* **No list of supported boards.** It has run on one device, one image, one pair of radios, and the
  README says so in those words. A stranger needs to know the evidence base is a single board before
  they trust a number.
* **No throughput figure.** It has never been measured on this build. Its absence is honest.
* **No claim that the kill-switch prevents leaks.** What it covers and what it does not belong in the
  same paragraph, because the gap is on the device's own output path and that is exactly the case
  somebody will assume is covered.
* **No implication that the tunnel protocols are all exercised.** Name the ones that were, against what,
  and leave the rest as untested rather than supported.

## The first thing a stranger will get wrong

Package names are not binary names — `dnsmasq` is in `dnsmasq-base`, `nft` is in `nftables`. This is in
the README's install block for that reason, and the device's own capability screen prints the correct
command for each gap. If the README's list and
[12-hardware-invariants](12-hardware-invariants.md#a-binarys-name-is-not-its-packages-name) ever
disagree, the measured table in `12` is the source.

## After publishing

Nothing here is a release process. There is no version to tag beyond what `package.json` says, no
artefact to upload, and no automated publication — deliberately, because a device that runs as root on
somebody's network should be installed by a person who read the deploy script.
