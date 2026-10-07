/**
 * The 360 px check: does any screen scroll sideways, and is anything too small to tap?
 *
 * ## Why this is a browser and not a test file
 *
 * The component tests beside it run in jsdom, which has **no layout engine**: every element reports
 * `scrollWidth === 0` and `getBoundingClientRect()` all zeroes. A check written there would pass on
 * a page overflowing by a thousand pixels — it could not produce the failure it claims to exclude,
 * which makes it worse than no check, because it would be quoted as one.
 *
 * So this drives real Chrome over the DevTools protocol, with a real viewport, and measures the
 * two things the owner actually reported: a page wider than the screen, and controls too small to
 * hit. It needs no dependency beyond a Chrome that is already installed and Node's own WebSocket.
 *
 * ## What it measures
 *
 * 1. **`documentElement.scrollWidth > clientWidth`** — the page scrolls sideways. This is the rule
 *    with no exceptions in [08-ui](../../docs/08-ui.md): not a table with a scrollbar, not a
 *    "just a few pixels".
 * 2. **Which elements stick out**, named with their classes, because "the page overflows" is not
 *    actionable and "`.row-field dd` reaches 512 px" is.
 * 3. **Every control smaller than 44 px**, for the same reason.
 * 4. **How many line boxes each run of text paints.**
 * 5. **How tall each screen is when it opens**, before any fold has been touched.
 * 6. **Labels over three words and help sentences over one**, which is rule 3 read literally.
 *
 * It exits non-zero on any finding, so it can gate a commit rather than be read.
 *
 * ## Why the break count was added, and why it is the measurement that matters
 *
 * Everything above 3 was width. A page can be exactly 360 px wide, clip nothing, and still be
 * unreadable — measured here on 2026-09-21, at 360 px, with every one of those checks reporting ok:
 * 299 runs of text painting four line boxes or more, a `span.row-title` of 389 characters laid out
 * as **sixteen lines in a 222 px box**, four `li` at fifteen, a `p.choice-consequence` at twelve.
 * None of it could turn this script red, because a box that wraps is a box that fits.
 *
 * **A length ceiling is not the worst case for a layout; a break count is.** A 200-character string
 * is fine in a card and ruinous in a 124 px column, and only the browser knows which it is in. So
 * the ceiling is on what was painted, not on what was written — which is also the one measurement
 * that improves when a column is widened rather than when a sentence is cut.
 *
 * Rule 6 says long values never break the layout: keys, certificates, profile blobs and URLs are
 * truncated with a copy control. The 389-character row title and the fifteen-line diff lines were
 * exactly those values, wrapping. They are `LongValue`s now, and `LongValue` paints one line box by
 * construction, so this check is what holds rule 6 rather than a habit.
 *
 * ## The height, and what it is measured before
 *
 * Every fold is opened before the width measurements, which is right for them and wrong for a
 * height: a screen with nineteen folds opened at once is not a screen anybody sees. So the height is
 * taken **first**, in the state a person arrives at, and the ceiling is about that state. The
 * tunnels screen measured 99 687 px with the folds open — 128 viewports — and the number the ceiling
 * is set against is the one a person actually scrolls.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'vite';

const WIDTH = Number(process.env['WAYFARER_CHECK_WIDTH'] ?? 360);
const HEIGHT = 780;

/**
 * The four ceilings, together, because each is a number somebody will want to argue with.
 *
 * `LINE_BOXES` — **six.** A card at 360 px fits about forty characters to a line, so the 120
 * characters rule 3 allows a help sentence paint three lines, and a deliberate two-part consequence
 * — the kind [08-ui](../../docs/08-ui.md) keeps on the plan review and the confirmation window,
 * because there the paragraph *is* what the reader is agreeing to — paints six. Seven is where a run
 * of text has stopped being a paragraph: every string above this ceiling on this bench was a long
 * value that rule 6 says to truncate, a sentence in a 124 px column, or a paragraph rule 3 says to
 * cut. Setting it at three would have been tidier and would have demanded cutting text this project
 * has already decided must stay, which is how a check gets an exception list.
 *
 * `SCREEN_HEIGHT` — **forty viewports**, measured with the folds as they open. The tunnels screen
 * holds sixteen tunnels, the longest realistic list this product is tested against, and the number
 * is a ceiling on *that*: a screen that needs more than forty screenfuls to scroll past has stopped
 * being a list and become a document. Deliberately not tight. It is here to catch a screen that has
 * stopped folding anything, which is a defect with no other symptom, and a tight number would be
 * re-tuned every time a fixture grows rather than read.
 *
 * `LABEL_WORDS` and `HELP_SENTENCES` are rule 3 from [08-ui](../../docs/08-ui.md), not a judgement
 * of our own. `HELP_CHARS` is the part rule 3 leaves to the reader — "one short sentence" — fixed at
 * 120 so that *short* is a number somebody can fail rather than a word everybody agrees with.
 */
const LINE_BOXES = 6;
const SCREEN_HEIGHT = HEIGHT * 40;
const LABEL_WORDS = 3;
const HELP_SENTENCES = 1;
const HELP_CHARS = 120;
const CHROME = process.env['WAYFARER_CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ── a minimal DevTools client ───────────────────────────────────────────────────────────── */

class Devtools {
  #socket;
  #next = 1;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiting = this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close() {
    this.#socket.close();
  }
}

/**
 * Chrome prints its WebSocket endpoint to stderr, but only once it is ready — polling the HTTP
 * endpoint instead would race with startup and report "no browser" for a browser that was starting.
 */
async function launchChrome(userDataDir) {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    /*
     * Without this the browser inherits the workstation's system proxy and sends a request for
     * 127.0.0.1 through it, which fails and renders Chrome's own error page. The check then reports
     * "no screen mounted" — true, and about the wrong thing entirely.
     */
    '--no-proxy-server',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]);

  let buffered = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome printed no DevTools endpoint in 20 s')), 20_000);
    chrome.stderr.on('data', (chunk) => {
      buffered += String(chunk);
      const match = buffered.match(/ws:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    chrome.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited with ${code} before answering:\n${buffered}`));
    });
  });

  return { chrome, endpoint };
}

/* ── what runs inside the page ───────────────────────────────────────────────────────────── */

const MEASURE = `(() => {
  const width = document.documentElement.clientWidth;
  const describe = (element) => {
    const id = element.id ? '#' + element.id : '';
    const cls = typeof element.className === 'string' && element.className
      ? '.' + element.className.trim().split(/\\s+/).join('.')
      : '';
    return element.tagName.toLowerCase() + id + cls;
  };

  const overflowing = [];
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    // Only the outermost offender is worth reporting: a parent pushed wide drags every child with
    // it, and a list of two hundred descendants hides the one element that caused it.
    if (rect.right > width + 0.5 || rect.left < -0.5) {
      const parent = element.parentElement;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        if (parentRect.right > width + 0.5 || parentRect.left < -0.5) continue;
      }
      overflowing.push({ selector: describe(element), why: 'box', left: Math.round(rect.left), right: Math.round(rect.right) });
      continue;
    }

    /*
     * The second, and the one a box measurement cannot see.
     *
     * A flex item with \`min-width: 0\` keeps a box inside the viewport while its *text* paints far
     * outside it — which is precisely the defect the owner reported, and the reason this branch
     * exists: measured by rectangles alone, an overflowing certificate looks perfectly contained
     * while the page scrolls sideways underneath it.
     *
     * Content wider than its box is only a defect where the box does not clip it, so the computed
     * \`overflow-x\` decides. \`LongValue\` is deliberately in exactly this state minus the clip, and
     * must not be reported.
     */
    if (element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0) {
      const style = getComputedStyle(element);
      if (style.overflowX === 'visible') {
        overflowing.push({
          selector: describe(element),
          why: 'content',
          left: Math.round(rect.left),
          right: Math.round(rect.left + element.scrollWidth),
        });
      }
    }
  }

  /*
   * How many line boxes each run of text paints.
   *
   * Measured with a \`Range\` over the **text node**, not over its element: an element's height
   * divided by a line height is a guess that a padded box, an inline image or a second child makes
   * wrong, and \`getClientRects()\` on a range is the browser reporting the line boxes it drew. The
   * tops are collapsed into a set because a line broken around an inline element produces two rects
   * on one line, and that is one break, not two.
   */
  const wrapping = [];
  for (const element of document.querySelectorAll('body *')) {
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = (node.textContent || '').trim();
      if (text === '') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      let rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
      /*
       * A clipped line box was not painted, and \`getClientRects()\` reports it anyway.
       *
       * This matters because it is the difference between measuring the remedy and measuring the
       * defect. \`-webkit-line-clamp\` lays every line out and shows three of them, so a range over a
       * clamped 389-character title reported **twenty-one lines** — worse than before it was fixed,
       * from a box a person sees three lines of. Only an element that actually clips gets this
       * treatment; one with \`overflow: visible\` is measured whole, which is the case where the text
       * really is on the screen and really does paint every line.
       */
      const clip = getComputedStyle(element);
      if (clip.overflow !== 'visible' && clip.overflowY !== 'visible') {
        const box = element.getBoundingClientRect();
        rects = rects.filter((rect) => rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1);
      }
      const lines = new Set(rects.map((rect) => Math.round(rect.top))).size;
      if (lines > ${LINE_BOXES}) {
        wrapping.push({
          selector: describe(element),
          lines,
          chars: text.length,
          box: Math.round(element.getBoundingClientRect().width),
          text: text.slice(0, 60),
        });
      }
    }
  }

  /*
   * Rule 3, read literally and over the **rendered** text rather than over the dictionary. A string
   * that is in the dictionary and on no screen is not a label anybody reads, and one assembled from
   * two pieces at render time is not in the dictionary at all.
   *
   * Counted once per distinct string: the same label on sixteen tunnel rows is one label to fix, and
   * a list that repeated it sixteen times would bury the fifteen other findings.
   */
  const words = (text) => text.trim().split(/\\s+/).filter(Boolean).length;
  const sentences = (text) => (text.trim().match(/[.!?](\\s|$)/g) || []).length || 1;
  const distinct = (selector) => [...new Set(
    [...document.querySelectorAll(selector)].map((element) => (element.textContent || '').trim()).filter(Boolean),
  )];

  // A button that carries its consequence has a label and a help sentence of its own, and obeys the
  // same rule as a field's; left out, the switch-off control's two sentences were measured by nothing.
  const labels = distinct('.field-label, .consequential-title');
  const longLabels = labels.filter((text) => words(text) > ${LABEL_WORDS}).map((text) => ({ words: words(text), text }));

  const helps = distinct('.field-help, .choice-consequence, .consequential-text');
  const longHelp = helps
    .filter((text) => text.length > ${HELP_CHARS} || sentences(text) > ${HELP_SENTENCES})
    .map((text) => ({ chars: text.length, sentences: sentences(text), text: text.slice(0, 70) }));

  const small = [];
  for (const element of document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"]')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.height < 44) {
      small.push({ selector: describe(element), height: Math.round(rect.height), text: (element.textContent || '').trim().slice(0, 40) });
    }
  }

  return {
    viewport: width,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    overflowing,
    small,
    wrapping,
    longLabels,
    longHelp,
    labelCount: labels.length,
    helpCount: helps.length,
    /*
     * Each anchor with what is actually inside it.
     *
     * The name alone was the second way this check could report success about nothing. "No screen
     * mounted" catches the whole page failing; it does not catch **one** anchor being empty, which is
     * what a component that returns early on absent data looks like. Its anchor is still in the list,
     * still named in the output, and every measurement below is true of the nothing inside it.
     */
    screens: [...document.querySelectorAll('[data-screen]')].map((element) => ({
      name: element.dataset.screen,
      elements: [...element.querySelectorAll('*')].filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 || box.height > 0;
      }).length,
      height: Math.round(element.getBoundingClientRect().height),
    })),
    /*
     * Requests the bench answered with nothing, which is the one way this check goes green on data
     * that does not exist: an unanswered query renders an empty list, an empty list fits, and every
     * measurement below reports "ok" about a screen nobody filled. The bench records them; this
     * reports them as a failure.
     */
    unanswered: window.__unanswered ?? [],
  };
})()`;

/* ── the run ─────────────────────────────────────────────────────────────────────────────── */

/*
 * `host` is stated because Vite otherwise binds to `::1` only, and the browser resolves
 * `127.0.0.1` — which connects to nothing and renders Chrome's own error page. The check then
 * reports "no screen mounted", which is true and about the wrong thing.
 *
 * `port: 0` is not honoured by Vite (it falls back to its default), so the port is named and
 * `strictPort` left off: a second run while a dev server is up picks the next free one.
 */
const server = await createServer({ server: { host: '127.0.0.1', port: 5199 }, logLevel: 'error' });
await server.listen();
const address = server.httpServer.address();
const base = `http://127.0.0.1:${address.port}`;

/*
 * Under `tmpdir()` and removed in the `finally` below. It used to be `${TMPDIR}wayfarer-check-360-<pid>`
 * and was never removed: measured 2026-10-07, every run left a Chrome profile of 44 entries behind,
 * and a TMPDIR without its trailing slash put it beside the temporary directory rather than in it.
 */
const userDataDir = join(tmpdir(), `wayfarer-check-360-${process.pid}`);
const { chrome, endpoint } = await launchChrome(userDataDir);

let failures = 0;
try {
  const socket = new WebSocket(endpoint);
  await once(socket, 'open');
  const browser = new Devtools(socket);

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  // A flat session multiplexes on one socket; every call has to carry the session it belongs to.
  const page = {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const handler = (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          socket.removeEventListener('message', handler);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        };
        socket.addEventListener('message', handler);
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
  };

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await page.send('Page.navigate', { url: `${base}/extremes.html` });
  // The screens render from queries that resolve on a microtask; a fixed wait is crude and this is
  // a local page with a stubbed fetch, so there is nothing slow to wait for.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  /*
   * The height each screen has **when it opens**, taken before a single fold is touched.
   *
   * Opening every fold is right for the width measurements and wrong for this one: a screen with
   * nineteen folds open at once is not a state anybody arrives in, and a ceiling set against it
   * would be a ceiling on the bench rather than on the product.
   */
  const { result: arrival } = await page.send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('[data-screen]')].map((element) => ({
      name: element.dataset.screen,
      height: Math.round(element.getBoundingClientRect().height),
    }))`,
    returnByValue: true,
  });

  /*
   * Every fold is opened before anything is measured.
   *
   * **The reason this was added is not the reason it is kept, and the difference was found by
   * mutating it.** It went in believing a closed `<details>` has no laid-out contents, so a folded
   * advanced section could overflow by any amount unseen. Measured on Chrome 153.0.8010.48
   * (2026-09-21) that is false: an element inside a *closed* fold was deliberately made 755 px wide
   * and this check reported it with the opening pass disabled, exactly as it did with it enabled.
   * Chrome lays closed fold contents out and the rectangles are real.
   *
   * What it is worth is narrower and stated so nobody quotes it for more. It makes this check
   * independent of a browser's private decision about whether to lay out hidden content — a
   * behaviour that has changed before — and it covers the case where a fold's body is *mounted* on
   * open rather than merely revealed, which no amount of laying out can reach. It is a belt, not
   * the thing that catches today's defect, and a mutation run against it will not fail.
   */
  const { result: opened } = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const folds = [...document.querySelectorAll('details')];
      for (const fold of folds) fold.open = true;
      return folds.length;
    })()`,
    returnByValue: true,
  });
  // Opening a fold triggers a layout pass and, for a lazily-fetched section, a query.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const { result } = await page.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
  const report = result.value;

  // Printed with the numbers rather than as a list of names: a screen whose element count has fallen to
  // a handful is the shape of a screen that stopped loading, and that is only visible beside the others.
  const arrivalHeight = new Map(arrival.value.map((screen) => [screen.name, screen.height]));
  console.log(
    `viewport ${report.viewport} px · ${opened.value} fold(s) opened\n` +
      report.screens
        .map(
          (screen) =>
            `  ${screen.name}: ${screen.elements} elements, ${arrivalHeight.get(screen.name) ?? '?'} px on arrival, ` +
            `${screen.height} px with every fold open`,
        )
        .join('\n'),
  );

  if (report.screens.length === 0) {
    console.error('FAIL: no screen mounted. The page rendered nothing, so nothing was measured.');
    failures += 1;
  }

  /*
   * An anchor with nothing in it, which every measurement below would pass.
   *
   * The floor is "not empty" rather than a number of elements, because any number would be a guess
   * about screens not written yet. What makes an empty anchor unambiguous is that nothing can be
   * measured about it at all: it is not a small screen, it is the absence of one wearing a screen's
   * name in the output.
   */
  const empty = report.screens.filter((screen) => screen.elements === 0);
  if (empty.length > 0) {
    console.error(`FAIL: ${empty.length} screen(s) rendered nothing, and every measurement below is about that nothing:`);
    for (const screen of empty) console.error(`  ${screen.name}`);
    failures += 1;
  } else {
    console.log(`ok: all ${report.screens.length} screens rendered something`);
  }

  if (report.unanswered.length > 0) {
    // Named before the layout findings, because a screen fed nothing makes every finding below
    // meaningless rather than merely incomplete.
    const routes = [...new Set(report.unanswered.map((url) => url.replace(/^https?:\/\/[^/]+/, '')))];
    console.error(`FAIL: ${routes.length} route(s) the bench answered with nothing — measured on data that does not exist:`);
    for (const route of routes) console.error(`  ${route}`);
    failures += 1;
  } else {
    console.log('ok: every request a screen made was answered from the fixtures');
  }

  if (report.scrollWidth > report.clientWidth) {
    console.error(`FAIL: the page scrolls sideways — ${report.scrollWidth} px of content in ${report.clientWidth} px.`);
    failures += 1;
  } else {
    console.log(`ok: no horizontal scrolling (${report.scrollWidth} px of content in ${report.clientWidth} px)`);
  }

  if (report.overflowing.length > 0) {
    console.error(`FAIL: ${report.overflowing.length} element(s) reach past the viewport:`);
    for (const entry of report.overflowing) {
      const why = entry.why === 'content' ? 'content wider than its box, unclipped' : 'box reaches past the viewport';
      console.error(`  ${entry.selector} — ${entry.left}…${entry.right} px — ${why}`);
    }
    failures += 1;
  } else {
    console.log('ok: nothing reaches past the viewport');
  }

  if (report.small.length > 0) {
    console.error(`FAIL: ${report.small.length} control(s) below 44 px:`);
    for (const entry of report.small) console.error(`  ${entry.selector} — ${entry.height} px — "${entry.text}"`);
    failures += 1;
  } else {
    console.log('ok: every control is at least 44 px tall');
  }

  /*
   * The break count, reported worst first and with the box it was painted in.
   *
   * The box width is on the line because it is half the finding: 182 characters is nothing in a card
   * and twelve lines in a 124 px column, and the two have different answers — cut the sentence, or
   * widen the column.
   */
  if (report.wrapping.length > 0) {
    /*
     * One line per distinct string, worst first. Sixteen tunnel rows carrying the same overlong
     * title are one thing to fix, and printing them sixteen times buries the fifteen other findings
     * under the loudest one — the same reason the text rules count distinct strings.
     */
    const seen = new Map();
    for (const entry of report.wrapping) {
      const key = `${entry.selector}\u0000${entry.text}`;
      const held = seen.get(key);
      if (held === undefined || held.lines < entry.lines) seen.set(key, entry);
    }
    const worst = [...seen.values()].sort((left, right) => right.lines - left.lines);
    console.error(
      `FAIL: ${report.wrapping.length} run(s) of text paint more than ${LINE_BOXES} line boxes ` +
        `(${worst.length} distinct):`,
    );
    for (const entry of worst.slice(0, 20)) {
      console.error(
        `  ${entry.selector} — ${entry.lines} lines of ${entry.chars} chars in ${entry.box} px — "${entry.text}"`,
      );
    }
    if (worst.length > 20) console.error(`  … and ${worst.length - 20} more`);
    failures += 1;
  } else {
    console.log(`ok: nothing paints more than ${LINE_BOXES} line boxes`);
  }

  const tall = arrival.value.filter((screen) => screen.height > SCREEN_HEIGHT);
  if (tall.length > 0) {
    console.error(`FAIL: ${tall.length} screen(s) taller than ${SCREEN_HEIGHT} px on arrival:`);
    for (const screen of tall) {
      console.error(`  ${screen.name} — ${screen.height} px, ${Math.round(screen.height / HEIGHT)} viewports`);
    }
    failures += 1;
  } else {
    console.log(`ok: every screen opens shorter than ${SCREEN_HEIGHT} px`);
  }

  if (report.longLabels.length > 0) {
    console.error(
      `FAIL: ${report.longLabels.length} of ${report.labelCount} label(s) are longer than ${LABEL_WORDS} words:`,
    );
    for (const entry of report.longLabels) console.error(`  ${entry.words} words — "${entry.text}"`);
    failures += 1;
  } else {
    console.log(`ok: all ${report.labelCount} labels are ${LABEL_WORDS} words or fewer`);
  }

  if (report.longHelp.length > 0) {
    console.error(
      `FAIL: ${report.longHelp.length} of ${report.helpCount} help/consequence string(s) are more than ` +
        `one sentence or longer than ${HELP_CHARS} characters:`,
    );
    for (const entry of [...report.longHelp].sort((left, right) => right.chars - left.chars).slice(0, 20)) {
      console.error(`  ${entry.chars} chars, ${entry.sentences} sentence(s) — "${entry.text}"`);
    }
    if (report.longHelp.length > 20) console.error(`  … and ${report.longHelp.length - 20} more`);
    failures += 1;
  } else {
    console.log(`ok: all ${report.helpCount} help strings are one sentence of at most ${HELP_CHARS} characters`);
  }

  browser.close();
} finally {
  // Chrome writes to its profile until it has exited, so the removal waits for the exit.
  const exited = chrome.exitCode === null ? once(chrome, 'exit') : Promise.resolve();
  chrome.kill();
  await exited;
  rmSync(userDataDir, { recursive: true, force: true });
  await server.close();
}

process.exit(failures === 0 ? 0 : 1);
