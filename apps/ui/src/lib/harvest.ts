/**
 * What the coverage manifest is allowed to count, and why an attribute is not enough.
 *
 * ## The hole this closes
 *
 * The harvest used to be `container.querySelectorAll('[data-pointer]')`. That answers *was this
 * pointer stamped onto something that rendered*, and parity asks **can a person supply this value**.
 * The two come apart in exactly one movement, and it is a movement anybody refactoring a screen
 * makes: replace a control with the markup around it.
 *
 * Measured, 2026-09-21, by substituting the Wi-Fi passphrase's `SecretField` in
 * `components/ProfileFields.tsx` with
 * `<div className="field-block" data-pointer={…}><span className="field-label">Passphrase</span></div>`:
 * the pointer was still in the DOM, there was no control of any kind, and the interface's whole
 * suite — 6 files, 113 tests, the parity comparison among them — passed. **The passphrase the daemon
 * refuses to activate a profile without had become inert text with every check green.** Deleting the
 * same block does fail, by name, which is what made the gap invisible: the check fails on the
 * obvious mutation and passes on the one somebody would actually commit.
 *
 * ## Three ways a value can be supplied, and each is proved rather than declared
 *
 * **A control that holds the value.** An `input`, `select`, `textarea`, a `contenteditable`, or an
 * element wearing one of ARIA's value roles — enabled, not read-only, not out of the tab order. A
 * `<span>`, a `<p>` and a `<dd>` are none of those: they are how a field is *described*, and
 * describing a field is what the defect above looks like.
 *
 * **A control behind a tap.** `SecretField` draws a credential the device already holds as a state
 * word and a **Replace** button; the input appears only after the tap. Five positions on the extreme
 * fixtures are in that state, so a gate that stopped at "is there an input right now" would have
 * reported five required fields as unreachable — a false red, and the cure for a false red is always
 * to weaken the check. Accepting the button instead would reopen the hole one door further in, since
 * `<button>Passphrase</button>` is as inert as the `<span>` was. So the button is **tapped** and the
 * question asked again.
 *
 * **A choice made by pressing one of several buttons.** Adding a tunnel is how `/tunnels/-/protocol`
 * is filled, and adding a rule is how `/routing/rules/-/kind` is; both are stamped onto a row of
 * buttons, and [08-ui](../../../../docs/08-ui.md) argues at length that this is a genuine choice
 * rather than a position to be excluded from the schema. Nothing in the markup distinguishes such a
 * group from a decorative one, so the markup is not what is consulted: the button is tapped and the
 * **document** is compared. A tap that writes a position whose shape is this pointer has proved the
 * pointer is fillable; a tap that writes nothing has proved nothing.
 *
 * Behaviour rather than a second annotation, deliberately. An attribute saying "this really is a
 * control" is the same kind of claim as the `data-pointer` that was believed here in the first
 * place, and it would go stale the same way.
 *
 * ## What is never tapped
 *
 * A block with a `[data-pointer]` inside it is a **container** — `/uplinks`, `/subscriptions`,
 * `/routing/ruleSets`, `/tunnels/-/config/entryPoints` — and the buttons inside those are Remove, Up
 * and Down. Tapping them was measured, on the first version of this file: every uplink, every feed
 * and every rule set was deleted from the draft, twenty-seven required positions vanished with them,
 * and the check reported the interface as editing almost nothing. A container is not a position a
 * person fills, so it is neither tapped nor counted.
 *
 * ## Layout cannot be consulted here and must not be faked
 *
 * This runs in jsdom, which has no layout engine, so `offsetParent`, `getClientRects()` and a
 * computed `display` report the same thing for a visible control and a hidden one. Visibility at
 * 360 px is the bench's question and it is asked in a real browser; what is asserted here is the
 * part jsdom can actually see — that the element exists, accepts input, and is not switched off.
 */

/** Every numeric segment becomes `-`: the manifest is about positions, not about this fixture's rows. */
export function normalisePointer(pointer: string): string {
  return pointer
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? '-' : segment))
    .join('/');
}

/**
 * The elements a value can be typed, picked or pasted into.
 *
 * The ARIA roles are the ones whose definition *is* holding a value. They are here because a control
 * built from a `div` and announced as a checkbox is a control, and refusing it would push authors
 * back towards native elements for a reason that has nothing to do with the person using the screen.
 * A `role` that is merely `button`, `group` or `presentation` is not on this list.
 */
const VALUE_CONTROL = [
  'input',
  'select',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="radio"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="textbox"]',
].join(', ');

/** Whether this one element is something a person can put a value into. */
export function acceptsInput(node: Element): boolean {
  if (!node.matches(VALUE_CONTROL)) return false;
  // A disabled or read-only control is on the screen and cannot be filled, which is the state the
  // defect above produced by other means. `aria-disabled` counts too: a control switched off for a
  // screen reader and live for everybody else is a different bug, not a reason to pass here.
  if (node.hasAttribute('disabled')) return false;
  if (node.getAttribute('aria-disabled') === 'true') return false;
  if (node.hasAttribute('readonly')) return false;
  if (node.getAttribute('aria-readonly') === 'true') return false;
  // Out of the tab order is out of reach for anybody not using a pointer, and rule 7 is touch first.
  if (node.getAttribute('tabindex') === '-1') return false;
  if (node.hasAttribute('hidden')) return false;
  if (node.tagName === 'INPUT' && node.getAttribute('type') === 'hidden') return false;
  return true;
}

/**
 * Whether the block holds a control **of its own**.
 *
 * `closest` rather than a plain descendant search, because a nested `[data-pointer]` would otherwise
 * lend its control to every ancestor — the container counting as covered because something inside it
 * is, which is the same "annotated, not fillable" mistake one level up.
 */
export function isFillable(block: Element): boolean {
  if (acceptsInput(block)) return true;
  for (const node of block.querySelectorAll(VALUE_CONTROL)) {
    if (node.closest('[data-pointer]') !== block) continue;
    if (acceptsInput(node)) return true;
  }
  return false;
}

/** A block holding other pointers is a container: a position in the document, never a control. */
export function isContainer(block: Element): boolean {
  return block.querySelector('[data-pointer]') !== null;
}

/** The buttons this block owns, in document order. */
function ownButtons(block: Element): HTMLButtonElement[] {
  return [...block.querySelectorAll('button')].filter(
    (button): button is HTMLButtonElement =>
      button.closest('[data-pointer]') === block && !button.hasAttribute('disabled'),
  );
}

/**
 * Every leaf position where two documents differ, as JSON Pointers.
 *
 * Arrays are descended **by index** rather than compared by length, which is the whole reason this
 * is here rather than `pendingChanges` from the draft store. That function reports a grown array as
 * one change at the array's own pointer — right for a pending-changes bar, and useless here: adding
 * a tunnel would read as a change at `/tunnels` and never mention `/tunnels/16/protocol`, which is
 * the position the button being tapped actually filled.
 */
export function changedPointers(before: unknown, after: unknown, pointer = ''): string[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: string[] = [];
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      out.push(...changedPointers(before[index], after[index], `${pointer}/${index}`));
    }
    return out;
  }
  if (isRecord(before) && isRecord(after)) {
    const out: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      out.push(...changedPointers(before[key], after[key], `${pointer}/${escapeSegment(key)}`));
    }
    return out;
  }
  if (isRecord(after) || Array.isArray(after)) {
    // A whole subtree that arrived at once — a tunnel, an entry point. Every leaf under it is a
    // position this tap filled, and the one the caller is asking about may be any of them.
    return leafPointers(after, pointer);
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [pointer];
}

function leafPointers(value: unknown, pointer: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => leafPointers(entry, `${pointer}/${index}`));
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPointers(entry, `${pointer}/${escapeSegment(key)}`),
    );
  }
  return [pointer];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export interface HarvestHooks {
  /** Activates an element, wrapped in whatever the caller's renderer needs. */
  click: (node: Element) => void;
  /** The edited document as it stands now. Omitted when there is none to read. */
  document?: () => unknown;
}

export interface Harvested {
  /** Positions a person can fill on this screen, normalised and sorted. */
  pointers: string[];
  /**
   * Positions that rendered with nothing anybody can fill.
   *
   * Reported rather than merely dropped: a pointer that silently stops being harvested reads in the
   * manifest diff as a control somebody deleted, and the two need different answers — one is a
   * screen that lost a field, the other is a field that became a caption.
   *
   * Containers are not in here. They are not positions a person fills and never were.
   */
  inert: string[];
}

/**
 * The positions this rendered screen lets a person fill.
 *
 * Destructive by design — it taps buttons and the draft moves — so it is called once per screen,
 * immediately before that screen is torn down.
 */
export function harvestScreen(container: ParentNode, hooks: HarvestHooks): Harvested {
  const fillable = new Set<string>();
  const candidates: { pointer: string; block: Element }[] = [];

  for (const block of container.querySelectorAll('[data-pointer]')) {
    const raw = block.getAttribute('data-pointer') ?? '';
    if (raw === '') continue;
    const pointer = normalisePointer(raw);
    if (isFillable(block)) {
      fillable.add(pointer);
      continue;
    }
    if (isContainer(block)) continue;
    candidates.push({ pointer, block });
  }

  /*
   * The tapping pass, after every block has been looked at without touching anything. Doing it
   * inline would mean measuring later blocks against a screen earlier taps had already changed.
   */
  for (const { pointer, block } of candidates) {
    if (fillable.has(pointer)) continue;
    for (const button of ownButtons(block)) {
      const before = hooks.document?.();
      hooks.click(button);
      if (isFillable(block)) {
        fillable.add(pointer);
        break;
      }
      if (hooks.document === undefined) continue;
      const written = changedPointers(before, hooks.document()).map(normalisePointer);
      if (written.includes(pointer)) {
        fillable.add(pointer);
        break;
      }
    }
  }

  const inert = candidates.map((entry) => entry.pointer).filter((pointer) => !fillable.has(pointer));
  return { pointers: [...fillable].sort(), inert: [...new Set(inert)].sort() };
}
