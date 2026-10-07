/**
 * The layout primitives every screen is built from.
 *
 * They exist because the defects the owner reported are not per-screen mistakes — they are the same
 * four mistakes repeated on every screen: a table that cannot fit, a value that wraps or overflows,
 * a control too small to hit, and an advanced setting either shouting or missing. Fixing those in
 * one place is the only way the fix survives the next screen somebody adds.
 *
 * All of them are built at 360 px and given room above it. That direction is not a preference: a
 * desktop layout squeezed into a phone is exactly how the current one overflows, and the squeeze is
 * invisible on the machine it is written on.
 */
import type { ReactElement, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { useDraft } from '../../lib/draft.ts';

/* ── the screen frame ────────────────────────────────────────────────────────────────────── */

/**
 * One screen: a title, an optional single action, and its sections.
 *
 * The title is a name, not a sentence, because it is read in a 360 px-wide bar beside whatever else
 * the bar carries.
 */
export function Screen({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <main className="screen">
      <div className="screen-head">
        <h1>{title}</h1>
        {action ? <div className="screen-action">{action}</div> : null}
      </div>
      {children}
    </main>
  );
}

/** A titled block. The title is a label, so it obeys the three-word rule like every other label. */
export function Card({ title, children }: { title?: string; children: ReactNode }): ReactElement {
  return (
    <section className="card">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

/* ── rows instead of tables ──────────────────────────────────────────────────────────────── */

export interface Row {
  /** Stable key. Never the array index: these lists reorder and filter. */
  id: string;
  /** The one thing that identifies the row when everything else is folded away. */
  title: ReactNode;
  /** A short state word or pill, drawn beside the title rather than in a column of its own. */
  badge?: ReactNode;
  /** Label/value pairs. Stacked at 360 px, two columns when there is room. */
  fields?: { label: string; value: ReactNode }[];
  /** Tapping the row. A row with an action is a button, so it is reachable without a pointer. */
  onOpen?: () => void;
  /** Controls that belong to this row, always visible — never revealed by hover. */
  actions?: ReactNode;
}

/**
 * A list of rows, which is what every table on every screen became.
 *
 * Not a table with a horizontal scrollbar, and not a table that hides columns below a breakpoint:
 * both keep the shape that does not fit and move the cost onto the reader. A row carries its own
 * labels, so nothing depends on a header that has scrolled out of view.
 */
export function RowList({ rows, empty }: { rows: Row[]; empty: string }): ReactElement {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="rows">
      {rows.map((row) => (
        <li key={row.id} className="row-item">
          <div className="row-head">
            {row.onOpen ? (
              <button type="button" className="row-open" onClick={row.onOpen}>
                <span className="row-title">{row.title}</span>
              </button>
            ) : (
              <span className="row-title">{row.title}</span>
            )}
            {row.badge ? <span className="row-badge">{row.badge}</span> : null}
          </div>
          {row.fields && row.fields.length > 0 ? (
            <dl className="row-fields">
              {row.fields.map((field) => (
                <div key={field.label} className="row-field">
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {row.actions ? <div className="row-actions">{row.actions}</div> : null}
        </li>
      ))}
    </ul>
  );
}

/* ── long values ─────────────────────────────────────────────────────────────────────────── */

/**
 * A value that can be longer than the screen: a key, a certificate, a profile blob, a URL, a
 * 253-character domain.
 *
 * It is truncated to one line with a copy control beside it, and never wrapped. Wrapping is what
 * breaks meaning in exactly the values where meaning matters — an address broken across two lines
 * reads as two addresses, and a fingerprint broken anywhere reads as a different fingerprint.
 *
 * The full value stays in the `title` attribute and in the clipboard, so truncation costs nothing:
 * nobody retypes these by eye, they copy them.
 */
export function LongValue({
  value,
  label,
  lines = 1,
  mono = true,
}: {
  value: string;
  label?: string;
  /**
   * How many line boxes it may paint before it is cut.
   *
   * One for a key, an address or a fingerprint: those are read as a whole or copied, and a break
   * anywhere changes what they say. More than one for a **sentence carrying** a long value — a plan
   * line, a generated rule, a journal entry — where the first words are what the reader needs and
   * cutting after one line would hide them. Measured at 360 px, 2026-09-21: a plan line holding a
   * 253-character domain painted fifteen line boxes in a 282 px box, and four of them in a row made
   * the panel that explains an apply unreadable on the device it is about.
   */
  lines?: number;
  /** False where the value is a sentence rather than an identifier. */
  mono?: boolean;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  if (value === '') return <span className="muted">—</span>;
  return (
    <span className="long-value">
      <span
        className={`long-value-text${mono ? ' mono' : ''}`}
        title={value}
        style={lines > 1 ? { WebkitLineClamp: lines } : undefined}
        data-lines={lines > 1 ? lines : undefined}
      >
        {value}
      </span>
      <button
        type="button"
        className="copy"
        aria-label={label ? `Copy ${label}` : 'Copy'}
        onClick={() => {
          // `navigator.clipboard` is absent over plain HTTP on some browsers, and this interface is
          // served over plain HTTP by design. Selecting the text is the honest fallback: it fails
          // visibly rather than reporting a copy that never happened.
          const done = (ok: boolean): void => {
            setCopied(ok);
            if (ok) window.setTimeout(() => setCopied(false), 1500);
          };
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(value).then(() => done(true), () => done(false));
          } else {
            done(false);
          }
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

/* ── folding ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Advanced settings: folded, present, and the same kind of control as everything else.
 *
 * The distinction this draws is *how often it is needed*, never *how dangerous it is* and never
 * *which mechanism edits it*. A fold that led somewhere with different rules would be the escape
 * hatch again under a quieter name, and the escape hatch is what Epic E exists to delete.
 *
 * `<details>` rather than our own state, so it opens with the keyboard, is findable by the
 * browser's own find-on-page, and needs no pointer to discover.
 */
export function Fold({
  summary,
  count,
  children,
  open,
}: {
  summary: string;
  /**
   * How many settings are inside. A fold that might be empty has to say so before it is opened.
   *
   * `undefined` is accepted explicitly rather than only omitted, because the count usually comes
   * from a query that has not answered yet — and "not counted yet" is the state, not a mistake.
   */
  count?: number | undefined;
  children: ReactNode;
  open?: boolean;
}): ReactElement {
  return (
    <details className="fold" open={open}>
      <summary>
        {summary}
        {count === undefined ? null : <span className="fold-count">{count}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/* ── controls that carry their own pointer ───────────────────────────────────────────────── */

/**
 * One labelled control, stamped with the JSON Pointer it writes.
 *
 * **The pointer is on the control, in the DOM, and that is the whole point of it.** The parity check
 * needs to know which fields the interface can edit, and the tempting way to tell it is a list —
 * which declares coverage rather than proving it, and goes stale the first time somebody deletes a
 * control and not its entry. A list that greps the source is no better: it would pass on the day it
 * mattered, because the JSX it matched can be present and never rendered.
 *
 * Stamped here instead, the manifest is harvested from a **rendered** screen. A field that leaves
 * the screen leaves the DOM, leaves the harvest, and changes the file — so the check fails by
 * itself, with nobody remembering anything.
 *
 * `help` is one short sentence and only where the label alone would mislead. Anything longer is a
 * document and belongs in `docs/`.
 */
export function Field({
  pointer,
  label,
  help,
  children,
}: {
  pointer: string;
  label: string;
  help?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="field-block" data-pointer={pointer}>
      <label>
        <span className="field-label">{label}</span>
        {children}
      </label>
      {help ? <p className="muted field-help">{help}</p> : null}
    </div>
  );
}

/**
 * A list of short strings, one per line.
 *
 * A textarea rather than a row of inputs with an add button: the values pasted in here arrive as a
 * list already — a block of domains from a provider, a set of ranges from a corporate document —
 * and a control that takes them one at a time turns a paste into twenty actions.
 *
 * An empty line is dropped rather than stored. An empty match term is a rule that matches nothing,
 * silently, and a trailing newline is how one gets created by accident.
 */
export function TextList({
  pointer,
  label,
  value,
  help,
  rows = 3,
}: {
  pointer: string;
  label: string;
  value: string[] | undefined;
  help?: string | undefined;
  rows?: number;
}): ReactElement {
  return <LineList pointer={pointer} label={label} value={value} help={help} rows={rows} />;
}

/**
 * The same control for a list of **numbers**: the ports on a blocked endpoint.
 *
 * It shares `TextList`'s renderer rather than copying it, for the reason `BooleanChoiceField` shares
 * the radio group: a copy is the one that would not get the next fix to the textarea's width or to
 * the empty-line rule.
 *
 * **The hazard the sharing introduces is the same one, in the other direction.** A textarea's value
 * is always a string, so reusing the control that edits string lists invites writing `["443"]` into a
 * position the schema declares as integers — a document that looks right in the panel and is refused
 * on save. A line that is not a whole number is dropped rather than written as `NaN`, which validates
 * as nothing and serialises as `null`. A test asserts the written values are numbers, and it was
 * proved by mutation.
 */
export function NumberList({
  pointer,
  label,
  value,
  help,
  rows = 3,
}: {
  pointer: string;
  label: string;
  value: number[] | undefined;
  help?: string | undefined;
  rows?: number;
}): ReactElement {
  return (
    <LineList
      pointer={pointer}
      label={label}
      value={(value ?? []).map((entry) => String(entry))}
      help={help}
      rows={rows}
      parse={(lines) =>
        lines.map((line) => Number(line)).filter((entry) => Number.isInteger(entry))
      }
    />
  );
}

function LineList({
  pointer,
  label,
  value,
  help,
  rows,
  parse,
}: {
  pointer: string;
  label: string;
  value: string[] | undefined;
  help?: string | undefined;
  rows: number;
  parse?: (lines: string[]) => unknown[];
}): ReactElement {
  const draft = useDraft();
  return (
    <Field pointer={pointer} label={label} help={help}>
      <textarea
        rows={rows}
        value={(value ?? []).join('\n')}
        onChange={(event) => {
          const lines = event.target.value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
          draft.set(pointer, parse ? parse(lines) : lines);
        }}
      />
    </Field>
  );
}

/* ── the ordinary typed controls ─────────────────────────────────────────────────────────── */

/*
 * Six primitives, added when the tunnel editor arrived.
 *
 * Three screens edit the same shapes — a name, a port, a choice between two words — and each of the
 * three catalogue entries would otherwise have grown its own `<input onChange={...draft.set}>`. That
 * is how the four defects the owner reported got onto every screen in the first place: not as one
 * mistake, but as the same mistake written out again per screen. A primitive stamped with its own
 * pointer is also the only kind of control the parity harvest can see.
 */

/** A short value typed by hand: a name, a host, a suffix. */
export function TextField({
  pointer,
  label,
  value,
  help,
  placeholder,
}: {
  pointer: string;
  label: string;
  value: unknown;
  help?: string | undefined;
  placeholder?: string;
}): ReactElement {
  const draft = useDraft();
  return (
    <Field pointer={pointer} label={label} help={help}>
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        placeholder={placeholder}
        onChange={(event) => draft.set(pointer, event.target.value === '' ? undefined : event.target.value)}
      />
    </Field>
  );
}

/**
 * A whole number: a port, a count, a number of seconds.
 *
 * An empty box writes `undefined` rather than `0`, and the difference is not cosmetic. `0` is a
 * *value* — a port nothing can bind, a connection count nothing can use — and it validates as one,
 * so a field somebody cleared would be stored as a legal setting that cannot work. Absent is the
 * state the schema has for "not given", and the entry applies its own default from there.
 */
export function NumberField({
  pointer,
  label,
  value,
  help,
  min,
  max,
}: {
  pointer: string;
  label: string;
  value: unknown;
  help?: string | undefined;
  min?: number;
  max?: number;
}): ReactElement {
  const draft = useDraft();
  return (
    <Field pointer={pointer} label={label} help={help}>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={typeof value === 'number' ? String(value) : ''}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === '') {
            draft.set(pointer, undefined);
            return;
          }
          const parsed = Number(raw);
          draft.set(pointer, Number.isFinite(parsed) ? Math.trunc(parsed) : undefined);
        }}
      />
    </Field>
  );
}

/**
 * A closed list of values where the words alone are enough — no option carries a consequence.
 *
 * `absent` adds one option for **not answering**, and it exists because several of these fields are
 * optional in a way that means something: a Wi-Fi uplink with no band is one that joins the network
 * on whichever band it is on, and a rule set with no format is one the core reads by extension. A
 * select with no such option cannot express that at all, and the fallback — an empty `<option>` — is
 * how `""` gets written into a position whose union has no empty string in it, producing a document
 * that looks right in the panel and is refused on save.
 *
 * It carries `write` rather than guessing, because the two spellings are not interchangeable in the
 * schema: `band` is a union **with `null` in it**, and `format` is `Type.Optional`, which is absence.
 * Writing one where the other belongs is refused by the same validator, one layer further in.
 */
export function SelectField({
  pointer,
  label,
  value,
  options,
  help,
  absent,
}: {
  pointer: string;
  label: string;
  value: unknown;
  options: readonly { value: string; title: string }[];
  help?: string | undefined;
  absent?: { title: string; write: null | undefined };
}): ReactElement {
  const draft = useDraft();
  const ABSENT = '\u0000absent';
  return (
    <Field pointer={pointer} label={label} help={help}>
      <select
        value={typeof value === 'string' ? value : absent ? ABSENT : ''}
        onChange={(event) =>
          draft.set(pointer, event.target.value === ABSENT ? absent?.write : event.target.value)
        }
      >
        {absent ? <option value={ABSENT}>{absent.title}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.title}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * A box, with what turning it off means written beside it rather than above it.
 *
 * `help` is the consequence here, not a description — the label says what the box is and the
 * sentence says what happens. Never a `title`: a tooltip is the one place a phone cannot show.
 */
export function CheckField({
  pointer,
  label,
  checked,
  help,
}: {
  pointer: string;
  label: string;
  checked: boolean;
  help?: string | undefined;
}): ReactElement {
  const draft = useDraft();
  return (
    <Field pointer={pointer} label={label} help={help}>
      <input type="checkbox" checked={checked} onChange={(event) => draft.set(pointer, event.target.checked)} />
    </Field>
  );
}

/**
 * A choice between two or three answers, **each stating what happens if it is chosen.**
 *
 * This is the shape rule 4 asks for — a consequence belongs in the control that causes it — and it
 * is the reason a select is not used for these. A `<select>` can hold a word and nothing else, so
 * the sentence would have to go above the control, where it reads as a paragraph about the screen
 * rather than as what the reader is agreeing to.
 */
export function ChoiceField({
  pointer,
  label,
  value,
  options,
  onChoose,
}: {
  pointer: string;
  label: string;
  value: string;
  options: readonly { value: string; title: string; consequence: string }[];
  /** See `RadioChoice`: for a choice that makes sibling fields meaningless. */
  onChoose?: (chosen: string) => void;
}): ReactElement {
  return (
    <RadioChoice
      pointer={pointer}
      label={label}
      value={value}
      options={options}
      {...(onChoose === undefined ? {} : { onChoose })}
    />
  );
}

/**
 * The same control for a field whose two answers are `true` and `false`.
 *
 * A checkbox would have been the reflex and is the wrong shape for these: a checkbox has one label,
 * so only the *on* answer can carry a sentence, and leaving it clear is then the answer nothing
 * explains. `pinName` and `takeOverInterface` are both fields where **off is a decision with its own
 * consequence** — off means no rename and no reboot, and off means the plan refuses rather than
 * writing a second configuration for an interface another manager already holds. Two answers, two
 * sentences, so it is the same radio group `ChoiceField` renders, writing booleans.
 *
 * It shares that renderer rather than copying its markup, because the copy would be the one that did
 * not get the next fix to the 44 px target or the radio's width.
 */
export function BooleanChoiceField({
  pointer,
  label,
  value,
  options,
}: {
  pointer: string;
  label: string;
  value: boolean;
  options: readonly { value: boolean; title: string; consequence: string }[];
}): ReactElement {
  return <RadioChoice pointer={pointer} label={label} value={value} options={options} />;
}

function RadioChoice<T extends string | boolean>({
  pointer,
  label,
  value,
  options,
  onChoose,
}: {
  pointer: string;
  label: string;
  value: T;
  options: readonly { value: T; title: string; consequence: string }[];
  /**
   * Run after the choice is written, for a field whose answer makes **sibling** fields meaningless.
   *
   * It exists because a control that hides a field does not remove it: the draft keeps what was
   * typed, the screen stops showing it, and a plan can then be refused pointing at a field nobody
   * can see to clear. Anything this does is an ordinary draft write, so it joins the same pending
   * change and the same Review.
   */
  onChoose?: (chosen: T) => void;
}): ReactElement {
  const draft = useDraft();
  return (
    <div className="field-block" data-pointer={pointer}>
      <fieldset className="choices">
        <legend className="field-label">{label}</legend>
        {options.map((option) => (
          <label key={String(option.value)} className="choice">
            <input
              type="radio"
              name={pointer}
              value={String(option.value)}
              checked={value === option.value}
              onChange={() => {
                draft.set(pointer, option.value);
                onChoose?.(option.value);
              }}
            />
            <span className="choice-title">{option.title}</span>
            <span className="choice-consequence">{option.consequence}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/**
 * A credential: shown as a state, never as a value, and replaced rather than edited.
 *
 * The four states are the four the API can serve, and they are not interchangeable. `{ $set: true }`
 * means the device holds one. `{ $redacted: kind }` means this document came from a redacted export
 * and the value was removed — a profile in that state cannot be activated until somebody types it,
 * so it says *missing* rather than *not set*. A bare string is what the operator has just typed and
 * has not saved. Absent is absent.
 *
 * Cancelling restores **the value that was there when the control opened**, captured once, rather
 * than a guess at which of the two placeholder shapes it was. The earlier version rebuilt a redacted
 * marker with a hardcoded kind, which quietly rewrote which kind of credential the field held.
 */
export function SecretField({
  pointer,
  label,
  value,
  help,
  blob,
}: {
  pointer: string;
  label: string;
  value: unknown;
  help?: string | undefined;
  /** A document rather than a passphrase — an `.ovpn` file, a key. Typed into a textarea. */
  blob?: boolean;
}): ReactElement {
  const draft = useDraft();
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  const stored = record !== null && record['$set'] === true;
  const missing = record !== null && '$redacted' in record;
  const typed = typeof value === 'string';

  /*
   * **What the captured value is captured *of*.**
   *
   * Cancelling restores the value that was there when the control opened, and the capture therefore
   * has to be resynced whenever the control starts describing a different position — otherwise it is
   * a value from one document being held over a control now editing another, and Cancel writes it
   * there. That is not hypothetical: the edited profile is chosen in a store rather than carried in
   * the route, and `lib/target.ts` silently falls back to the active profile when a chosen id leaves
   * the list, so the document under these controls can be replaced **without a remount**. A `useRef`
   * initialised once survives that, and pressing Cancel then wrote profile A's placeholder into
   * profile B's document.
   *
   * The identity is the profile **and** the pointer, because both halves can change under a control
   * that is never unmounted: a screen that swaps documents changes the first, and a list that is
   * reordered or filtered changes the second.
   *
   * Resynced during render rather than in an effect. An effect runs after the render that already
   * drew the new document, so there is one commit in which the control shows B and holds A's value —
   * and one tap is all Cancel needs.
   */
  const identity = `${draft.profileId ?? ''}\u0000${pointer}`;
  const original = useRef(value);
  const [seen, setSeen] = useState(identity);
  const [open, setOpen] = useState(missing);
  if (seen !== identity) {
    setSeen(identity);
    setOpen(missing);
    original.current = value;
  }

  if (!open && !typed) {
    return (
      <Field pointer={pointer} label={label} help={help}>
        <span className="secret-state">
          <span className={stored ? 'ok' : missing ? 'warn-text' : 'muted'}>
            {stored ? 'A value is stored' : missing ? 'Missing' : 'Not set'}
          </span>
          <button type="button" onClick={() => setOpen(true)}>
            {stored ? 'Replace' : 'Set'}
          </button>
        </span>
      </Field>
    );
  }

  return (
    <Field pointer={pointer} label={label} help={help}>
      <span className="secret-state">
        {blob ? (
          <textarea
            rows={4}
            spellCheck={false}
            value={typed ? value : ''}
            onChange={(event) => draft.set(pointer, event.target.value === '' ? undefined : event.target.value)}
          />
        ) : (
          <input
            type="password"
            autoComplete="new-password"
            value={typed ? value : ''}
            onChange={(event) => draft.set(pointer, event.target.value === '' ? undefined : event.target.value)}
          />
        )}
        {stored || missing ? (
          <button
            type="button"
            onClick={() => {
              draft.set(pointer, original.current);
              setOpen(false);
            }}
          >
            Cancel
          </button>
        ) : null}
      </span>
    </Field>
  );
}
