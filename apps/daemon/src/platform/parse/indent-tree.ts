/**
 * `iw` prints trees indented with tabs and has no JSON output, so every `iw` parser
 * here works on a tree built from indentation rather than on flat regular
 * expressions. The difference matters in practice: a flat matcher that looks for
 * "Frequencies:" anywhere finds the frequency list of whichever band happened to be
 * printed last, while a tree keeps a frequency attached to its own band. Driver
 * output also varies in which optional lines appear, and a tree simply has fewer
 * children in that case instead of shifting every subsequent match.
 */

export interface IndentNode {
  /** The line with its indentation removed and trailing whitespace trimmed. */
  text: string;
  /** Number of leading tabs. */
  depth: number;
  children: IndentNode[];
}

/**
 * Some sections wrap a single logical entry over several lines and indent the
 * continuation with spaces rather than tabs — interface combinations do exactly
 * this. Leading spaces are therefore preserved in `text` so a caller can tell a
 * continuation from a new entry.
 */
export function parseIndentTree(input: string): IndentNode[] {
  const roots: IndentNode[] = [];
  const stack: IndentNode[] = [];

  for (const rawLine of input.split('\n')) {
    if (rawLine.trim() === '') continue;
    let depth = 0;
    while (depth < rawLine.length && rawLine[depth] === '\t') depth += 1;
    const node: IndentNode = { text: rawLine.slice(depth).replace(/\s+$/, ''), depth, children: [] };

    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  return roots;
}

/** First child whose text matches, or undefined. Prefix match, not substring. */
export function childStartingWith(node: IndentNode, prefix: string): IndentNode | undefined {
  return node.children.find((c) => c.text.startsWith(prefix));
}

/** Children rendered as a bullet list (`* value`), with the bullet removed. */
export function bulletValues(node: IndentNode | undefined): string[] {
  if (!node) return [];
  // Bullets are indented inconsistently: `Supported interface modes` prints
  // "\t\t * managed" (a space before the asterisk) while `Supported Ciphers` prints
  // "\t\t* CCMP-128". Trimming first is what makes one reader handle both.
  return node.children
    .map((c) => c.text.trim())
    .filter((t) => t.startsWith('* '))
    .map((t) => t.slice(2).trim());
}

/**
 * Value of a `key: value` line among a node's children. Returns undefined when the
 * line is absent, which is the normal case for a driver that does not implement
 * that report — callers must treat it as unknown rather than as zero.
 */
export function keyValue(node: IndentNode, key: string): string | undefined {
  const hit = node.children.find((c) => c.text.startsWith(`${key}:`));
  if (!hit) return undefined;
  return hit.text.slice(key.length + 1).trim();
}

export function parseIntOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /-?\d+/.exec(value);
  if (!match) return null;
  const n = Number.parseInt(match[0], 10);
  return Number.isFinite(n) ? n : null;
}
