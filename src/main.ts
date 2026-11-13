import {
  App,
  debounce,
  Editor,
  finishRenderMath,
  ItemView,
  loadMathJax,
  MarkdownView,
  moment,
  Plugin,
  PluginSettingTab,
  renderMath,
  Scope,
  Setting,
  SettingControl,
  SettingDefinitionGroup,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

// Obsidian re-exports its bundled moment instance. Some type-checkers — including
// the community plugin review scanner — widen that re-export to `any`, which trips
// @typescript-eslint's no-unsafe-* rules on every moment call. Re-bind it through
// moment's real module type so all the date logic below stays fully type-checked.
// (The `moment.Moment` type from the original import is still used for typing.)
const typedMoment = moment as unknown as typeof import("moment");

const VIEW_TYPE = "checklist";

// How long a checked-off todo stays in the panel, so it can be unchecked again.
// Keep in sync with the checklist-done-fade animation in styles.css.
const DONE_LINGER_MS = 5000;

// Reverts one panel action; resolves false if there was nothing left to revert.
type UndoFn = () => Promise<boolean>;
// Panel actions Cmd/Ctrl+Z can step back through.
const MAX_UNDO = 100;

interface TodoHeading {
  text: string;
  line: number;
}

interface TodoItem {
  file: TFile;
  lineIndex: number;
  text: string;
  // Nesting level mirrored from the source note (0 = top level). Optional so that
  // transient TodoItems built outside getAllTodos default to unindented.
  depth?: number;
  // Nearest heading above the todo in its note, if there is one.
  heading?: TodoHeading;
  // Just checked off: shown greyed out until it fades from the panel (see DONE_LINGER_MS).
  done?: boolean;
  // Checked off earlier and shown below the note's open todos (see the
  // "Show completed todos" setting), greyed out but without fading.
  completed?: boolean;
}

type SortMode = "recent" | "oldest" | "alpha" | "alpha-desc";
type TodoScope = "vault" | "note" | "folder";

const SCOPE_OPTIONS: Record<TodoScope, string> = {
  vault: "Entire vault",
  note: "Current note",
  folder: "Current folder and subfolders",
};

function isTodoScope(value: unknown): value is TodoScope {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SCOPE_OPTIONS, value);
}

type CompletedRange = "none" | "today" | "3days" | "week" | "7days" | "month" | "30days" | "all";

const COMPLETED_OPTIONS: Record<CompletedRange, string> = {
  none: "None",
  today: "Today",
  "3days": "Last 3 days",
  week: "This week",
  "7days": "Last 7 days",
  month: "This month",
  "30days": "Last 30 days",
  all: "All",
};

function isCompletedRange(value: unknown): value is CompletedRange {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMPLETED_OPTIONS, value);
}

// Start (ms) of the time span a range covers; null for "all", which isn't limited.
function completedSince(range: Exclude<CompletedRange, "none">): number | null {
  switch (range) {
    case "today": return typedMoment().startOf("day").valueOf();
    case "3days": return typedMoment().subtract(3, "days").valueOf();
    case "week": return typedMoment().startOf("week").valueOf();
    case "7days": return typedMoment().subtract(7, "days").valueOf();
    case "month": return typedMoment().startOf("month").valueOf();
    case "30days": return typedMoment().subtract(30, "days").valueOf();
    case "all": return null;
  }
}

// When a todo was checked off. Recorded for every todo checked off (in the
// panel or the note), whatever "Show completed todos" is set to, so switching
// the setting shows past completions right away. The record points at its
// "- [x]" line by note path and text, like the panel's rows, so it survives
// line shifts; renames, edits, unchecking and moves update it (see
// updateCompletions and resolveCompletedTodos).
interface CompletionRecord {
  path: string;
  text: string;
  at: number;
}

function isCompletionRecord(value: unknown): value is CompletionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && typeof record.text === "string" && typeof record.at === "number";
}

// How long completion records are kept: long enough for "Last 30 days" and
// "This month" (up to 31 days back).
const COMPLETION_RETENTION_MS = 32 * 24 * 60 * 60 * 1000;

function countTexts(items: Iterable<{ text: string }> | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { text } of items ?? []) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
}

function compareNoteGroups(a: TFile, b: TFile, mode: SortMode): number {
  switch (mode) {
    case "alpha":
      return a.basename.localeCompare(b.basename);
    case "alpha-desc":
      return b.basename.localeCompare(a.basename);
    case "oldest":
      return a.stat.mtime - b.stat.mtime;
    case "recent":
    default:
      return b.stat.mtime - a.stat.mtime;
  }
}

interface ChecklistSettings {
  todoScope: TodoScope;
  sortMode: SortMode;
  // Show note titles and dividers; off shows only the todos ("bare" mode).
  showNoteTitles: boolean;
  // Group each note's todos under the nearest heading above them.
  showHeadings: boolean;
  dateNotesOnly: boolean;
  hideFutureDateNotes: boolean;
  movePastTodosToToday: boolean;
  // Checking off a todo in the panel also checks off its nested todos.
  completeNestedTodos: boolean;
  // Exclude rules, one per line: keyword, "Folder/", "Note.md" or "/regex/".
  excludeRules: string;
  // Note paths pinned to the top of the panel, in pin order (most-recent last).
  pinnedPaths: string[];
  // Folded note titles and headings in the panel (see foldKey).
  foldedKeys: string[];
  // Checked-off todos shown below each note's open todos, by when they were checked off.
  showCompleted: CompletedRange;
  // When todos were checked off, for the last COMPLETION_RETENTION_MS.
  completions: CompletionRecord[];
}

// Settings edited through the settings tab (pinnedPaths, foldedKeys and
// completions are managed by the plugin).
type EditableSettingKey = Exclude<keyof ChecklistSettings, "pinnedPaths" | "foldedKeys" | "completions">;
type BooleanSettingKey = {
  [K in EditableSettingKey]: ChecklistSettings[K] extends boolean ? K : never;
}[EditableSettingKey];

const DEFAULT_SETTINGS: ChecklistSettings = {
  todoScope: "vault",
  sortMode: "recent",
  showNoteTitles: true,
  showHeadings: false,
  dateNotesOnly: false,
  hideFutureDateNotes: false,
  movePastTodosToToday: false,
  completeNestedTodos: false,
  excludeRules: "",
  pinnedPaths: [],
  foldedKeys: [],
  showCompleted: "none",
  completions: [],
};

interface DragTodoPayload {
  sourcePath: string;
  text: string;
  lineIndex: number;
  occurrence: number;
}

const DRAG_MIME = "application/x-checklist-todo";

// Drop position for moveTodo: next to `todo`, before it or after its nested
// children. The moved todo takes `todo`'s indentation.
interface DropAnchor {
  todo: TodoItem;
  after: boolean;
}

function isDragTodoPayload(value: unknown): value is DragTodoPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.sourcePath === "string" &&
    typeof payload.text === "string" &&
    typeof payload.lineIndex === "number" &&
    typeof payload.occurrence === "number"
  );
}

// Exclude rules, one per line. The shape of a line decides what it matches:
//   /weekly planner/   regex on the note path (case-insensitive)
//   Templates/         folder, including subfolders
//   Inbox/Scratch.md   single note
//   define             keyword in the todo text (case-insensitive)
interface ExcludeRules {
  keywords: string[];
  folders: string[];
  notes: string[];
  patterns: RegExp[];
  // Regex lines that don't compile; ignored, but listed in the settings.
  invalid: string[];
}

function parseExcludeRules(raw: string): ExcludeRules {
  const rules: ExcludeRules = { keywords: [], folders: [], notes: [], patterns: [], invalid: [] };
  for (const line of raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)) {
    if (line.length > 2 && line.startsWith("/") && line.endsWith("/")) {
      try {
        rules.patterns.push(new RegExp(line.slice(1, -1), "i"));
      } catch {
        rules.invalid.push(line);
      }
    } else if (line.endsWith("/")) {
      const folder = line.replace(/^\/+|\/+$/g, "").toLowerCase();
      if (folder.length > 0) rules.folders.push(folder);
    } else if (line.toLowerCase().endsWith(".md")) {
      rules.notes.push(line.replace(/^\/+/, "").toLowerCase());
    } else {
      rules.keywords.push(line.toLowerCase());
    }
  }
  return rules;
}

function hasExcludeRules(rules: ExcludeRules): boolean {
  return rules.keywords.length + rules.folders.length + rules.notes.length + rules.patterns.length > 0;
}

function isNoteExcluded(filePath: string, rules: ExcludeRules): boolean {
  const lower = filePath.toLowerCase();
  return (
    rules.notes.includes(lower) ||
    rules.folders.some((f) => lower.startsWith(`${f}/`)) ||
    rules.patterns.some((re) => re.test(filePath))
  );
}

function isTodoExcluded(text: string, rules: ExcludeRules): boolean {
  const lower = text.toLowerCase();
  return rules.keywords.some((k) => lower.includes(k));
}

// Priority marker: count the trailing "!" of an item so "!!" ranks above "!"
// above none. Trailing whitespace is ignored ("do it !! " counts as 2).
function trailingBangs(text: string): number {
  const m = text.trimEnd().match(/!+$/);
  return m ? m[0].length : 0;
}

// Reorder a note's todos (given in line order, each carrying its nesting `depth`)
// so priority sorting happens per indentation level: siblings under the same
// parent are ordered by trailing "!" (more first), then ==highlighted== todos
// before plain ones (ties keep written order), and
// every item carries its nested descendants along with it. A "!" on a parent
// only reorders it among its siblings — it never lifts a nested item across
// levels, and never leaves that item's children behind.
function sortTodosByPriority(items: TodoItem[]): TodoItem[] {
  const order = (start: number, end: number): TodoItem[] => {
    // Split items[start..end) into sibling groups: the first item is a parent,
    // and every following item deeper than it is part of its subtree.
    const groups: Array<{ item: TodoItem; children: TodoItem[] }> = [];
    let i = start;
    while (i < end) {
      const base = items[i].depth ?? 0;
      let j = i + 1;
      while (j < end && (items[j].depth ?? 0) > base) j++;
      groups.push({ item: items[i], children: order(i + 1, j) });
      i = j;
    }
    // Sort siblings by trailing "!" (descending), then highlighted before plain,
    // keeping written order on ties.
    const sorted = groups
      .map((g, idx) => ({ g, idx, bangs: trailingBangs(g.item.text), mark: hasHighlight(g.item.text) ? 1 : 0 }))
      .sort((a, b) => (b.bangs - a.bangs) || (b.mark - a.mark) || (a.idx - b.idx));
    const out: TodoItem[] = [];
    for (const { g } of sorted) out.push(g.item, ...g.children);
    return out;
  };
  return order(0, items.length);
}

// Priority-sorts each run of consecutive todos under the same heading on its
// own, so every heading's todos stay together below a single label.
function sortTodosWithinHeadings(items: TodoItem[]): TodoItem[] {
  const out: TodoItem[] = [];
  let start = 0;
  for (let i = 1; i <= items.length; i++) {
    if (i === items.length || items[i].heading?.text !== items[start].heading?.text) {
      out.push(...sortTodosByPriority(items.slice(start, i)));
      start = i;
    }
  }
  return out;
}

// Puts each completed todo after the open todos of its heading (todos are
// grouped by heading in note order, see sortTodosWithinHeadings). A heading
// with only completed todos gets its own section, in note order.
function mergeUnderHeadings(open: TodoItem[], done: TodoItem[]): TodoItem[] {
  const sections = new Map<number, TodoItem[]>();
  const add = (todo: TodoItem) => {
    const line = todo.heading?.line ?? -1;
    if (!sections.has(line)) sections.set(line, []);
    sections.get(line)!.push(todo);
  };
  open.forEach(add);
  done.forEach(add);
  return [...sections.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, todos]) => todos);
}

// Todo lines, with optional callout prefix(es): "  > > - [ ] text" matches.
// TODO_OPEN_RE captures the trailing text; the *_PREFIX variants are tests only.
const TODO_OPEN_RE = /^\s*(?:>\s*)*-\s\[ \]\s(.+)/;
const TODO_OPEN_PREFIX = /^\s*(?:>\s*)*-\s\[ \]/;
const TODO_DONE_RE = /^\s*(?:>\s*)*-\s\[x\]\s(.+)/;
const TODO_DONE_PREFIX = /^\s*(?:>\s*)*-\s\[x\]/;
// Any number of "#" and a space at the very start of a line, captures the title.
const HEADING_RE = /^#+ +(\S.*)/;
const CALLOUT_OPEN_RE = /^\s*((?:>\s*)*)\[!([a-zA-Z0-9-]+)\]([+-])?/;

// Visual width of a todo line's list indentation, in columns (tab = 4). Blockquote
// markers are stripped first so callout todos aren't counted as list nesting. Used
// only for relative comparison, so the exact tab size doesn't matter.
function listIndentWidth(line: string): number {
  const withoutQuote = line.replace(/^(?:\s*>)+\s?/, "");
  const lead = /^[\t ]*/.exec(withoutQuote)?.[0] ?? "";
  const tabs = (lead.match(/\t/g) ?? []).length;
  // Each tab counts as 4 columns; spaces as 1. Exact size only matters relatively.
  return lead.length + tabs * 3;
}

function blockquotePrefix(line: string): string {
  const m = line.match(/^\s*((?:>\s*)*)/);
  return m?.[1] ?? "";
}

function blockquoteDepth(prefix: string): number {
  return (prefix.match(/>/g) ?? []).length;
}

// Splits a line into its blockquote/callout marker ("> ", "> > ") and the
// list indentation that follows it.
function splitListIndent(line: string): { quote: string; indent: string } {
  const quote = /^(?:\s*>)+\s?/.exec(line)?.[0] ?? "";
  const indent = /^[\t ]*/.exec(line.slice(quote.length))?.[0] ?? "";
  return { quote, indent };
}

// Re-indents a moved block (a todo and its nested lines) so the todo uses
// `indent`; nested lines shift by the same amount and keep their structure.
function reindentBlock(block: string[], indent: string): string[] {
  const old = splitListIndent(block[0]).indent;
  if (old === indent) return block;
  return block.map((line) => {
    const { quote } = splitListIndent(line);
    const rest = line.slice(quote.length);
    return rest.startsWith(old) ? quote + indent + rest.slice(old.length) : line;
  });
}

// Given a todo line's index, return the indices of the lines directly nested
// underneath it — the contiguous run of following lines that are more deeply
// indented, within the same blockquote context. These are the todo's child
// items (and their wrapped content), so they travel with the todo when it is
// moved. Stops at the first blank line, a line at the same or shallower
// indentation, or a change in blockquote depth.
function collectDescendantLines(lines: string[], parentIdx: number): number[] {
  const parentIndent = listIndentWidth(lines[parentIdx]);
  const parentQuoteDepth = blockquoteDepth(blockquotePrefix(lines[parentIdx]));
  const result: number[] = [];
  for (let i = parentIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) break;
    if (blockquoteDepth(blockquotePrefix(line)) !== parentQuoteDepth) break;
    if (listIndentWidth(line) <= parentIndent) break;
    result.push(i);
  }
  return result;
}

function findCalloutHeaderLine(lines: string[], todoIdx: number): number | null {
  const todoDepth = blockquoteDepth(blockquotePrefix(lines[todoIdx] ?? ""));
  if (todoDepth === 0) return null;

  for (let i = todoIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const depth = blockquoteDepth(blockquotePrefix(line));
    if (depth === 0) break;
    if (depth > todoDepth) continue;
    if (depth < todoDepth) break;
    if (CALLOUT_OPEN_RE.test(line)) return i;
  }
  return null;
}

function collectMigrationLines(lines: string[], indices: number[]): string[] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const groups = new Map<string, { start: number; end: number; lines: string[] }>();

  for (const idx of sorted) {
    const line = lines[idx];
    if (!line || !TODO_OPEN_PREFIX.test(line)) continue;
    const headerIdx = findCalloutHeaderLine(lines, idx);
    const key = headerIdx !== null ? `h:${headerIdx}` : `t:${idx}`;
    if (!groups.has(key)) {
      groups.set(key, {
        start: headerIdx ?? idx,
        end: idx,
        lines: headerIdx !== null ? [lines[headerIdx]] : [],
      });
    }
    const group = groups.get(key)!;
    group.lines.push(line);
    group.end = idx;
  }

  // Keep a single blank line between groups of todos that were separated by a
  // blank line in the source note (todos "grouped" by newline). Todos that sat
  // directly next to each other stay adjacent.
  const result: string[] = [];
  let prevEnd: number | null = null;
  for (const group of [...groups.values()].sort((a, b) => a.start - b.start)) {
    if (prevEnd !== null && group.start - prevEnd > 1) result.push("");
    result.push(...group.lines);
    prevEnd = group.end;
  }
  return result;
}

// After the open todos inside a callout have been moved out, the callout can be
// left with just its header (and empty blockquote lines). Given the indices of
// the todos being removed, returns the extra line indices — the callout header
// and any now-empty blockquote lines belonging to it — that should be removed
// too, but only for callouts that (a) contained a moved todo and (b) have no
// other content left. Blank lines surrounding the callout are left untouched so
// the separation to neighbouring callouts and todos is kept.
function collectEmptyCalloutRemovals(lines: string[], removedTodoIndices: number[]): number[] {
  const removed = new Set(removedTodoIndices);
  const extra: number[] = [];

  for (let h = 0; h < lines.length; h++) {
    if (!CALLOUT_OPEN_RE.test(lines[h])) continue;
    const headerDepth = blockquoteDepth(blockquotePrefix(lines[h]));
    if (headerDepth === 0) continue;

    // The callout body spans the following lines that stay within its blockquote.
    let end = h + 1;
    while (end < lines.length && blockquoteDepth(blockquotePrefix(lines[end])) >= headerDepth) {
      end++;
    }

    let hadMovedTodo = false;
    let hasRemainingContent = false;
    for (let i = h + 1; i < end; i++) {
      if (removed.has(i)) {
        hadMovedTodo = true;
        continue;
      }
      const content = lines[i].replace(/^\s*(?:>\s*)*/, "").trim();
      if (content.length > 0) hasRemainingContent = true;
    }

    if (hadMovedTodo && !hasRemainingContent) {
      for (let i = h; i < end; i++) if (!removed.has(i)) extra.push(i);
    }
  }

  return extra;
}

// Daily note formats may contain "/" (e.g. "YYYY/MM/YYYY-MM-DD"), which the
// Daily Notes plugin turns into subfolders. Match the format against as many
// trailing path segments as it has, not just the basename. Slashes inside
// moment's [escaped] literals don't count as separators.
function parseDateNote(file: TFile, format: string): moment.Moment {
  const segments = format.replace(/\[[^\]]*\]/g, "").split("/").length;
  const name = file.path.slice(0, file.path.length - file.extension.length - 1);
  const tail = name.split("/").slice(-segments).join("/");
  return typedMoment(tail, format, true);
}

// Minimal shape of the Daily Notes core plugin we touch. The internalPlugins
// container isn't in Obsidian's public type definitions, so we declare just
// enough to safely read the format setting.
interface DailyNotesPluginInstance {
  options?: { format?: string; folder?: string };
  createDailyNote?: (date?: moment.Moment) => Promise<TFile>;
}
interface InternalPluginContainer {
  getPluginById(id: "daily-notes"): { instance?: DailyNotesPluginInstance } | null;
}
interface AppWithInternalPlugins {
  internalPlugins?: InternalPluginContainer;
}

// Matches [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]],
// the "[label](" start of markdown links, bare http(s) URLs, inline code `code`,
// and LaTeX math $$display$$ / $inline$. Like in Obsidian, inline math must not
// start or end with a space and the closing "$" must not be followed by a digit,
// so "costs $5 and $10" stays text; "\$" is a literal dollar sign.
// **Bold**, *italic*, ~~strikethrough~~ and ==highlights== are found afterwards in the plain text between these (see findStyleMarkers).
// Markdown link labels may contain one level of nested brackets; the link target
// is found by findLinkTargetEnd so parentheses inside URLs are counted.
// Bare URLs may contain balanced parentheses ("…/Foo_(bar)") but don't swallow
// a closing ")" around them ("(see https://x.y)").
const LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]|\[((?:[^[\]]|\[[^[\]]*\])+)\]\(|(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+)|`([^`]+)`|(?<!\\)\$\$((?:\\.|[^$\\])+?)\$\$|(?<![\\$])\$(?![\s$])((?:\\.|[^$\\])+?)(?<!\s)\$(?!\d)/g;

// Index of the ")" that closes a markdown link target starting at `start` (just
// after its "("), counting nested parentheses so URLs like "…?q=(a)&id=1" stay
// intact. Backslash-escaped characters don't count. Returns -1 if never closed.
function findLinkTargetEnd(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

// External URL = anything with a scheme (http:, https:, mailto:, ftp:, obsidian:, …).
// Vault-relative targets like "Notes/foo" or "#heading" don't match.
function isExternalUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function createExternalLink(container: HTMLElement, label: string, href: string): void {
  const link = container.createEl("a", { cls: "checklist-inline-link", text: label, href });
  link.setAttr("target", "_blank");
  link.setAttr("rel", "noopener noreferrer");
  link.addEventListener("click", (e) => { e.stopPropagation(); });
}

type TodoTextToken =
  | { kind: "text"; start: number; end: number }
  | { kind: "wikilink"; target: string; subpath: string; label: string }
  | { kind: "link"; target: string; label: string }
  | { kind: "url"; url: string }
  | { kind: "code"; code: string }
  | { kind: "math"; source: string; display: boolean };

// Splits todo text into plain-text ranges and links / URLs / inline code / math.
function tokenizeTodoText(text: string): TodoTextToken[] {
  const tokens: TodoTextToken[] = [];
  const pushText = (start: number, end: number) => {
    if (end <= start) return;
    const prev = tokens[tokens.length - 1];
    if (prev?.kind === "text" && prev.end === start) prev.end = end;
    else tokens.push({ kind: "text", start, end });
  };
  let last = 0;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    pushText(last, m.index);
    let end = m.index + m[0].length;
    if (m[1] !== undefined) {
      const target = m[1].trim();
      const heading = m[2]?.trim() ?? "";
      const label = m[3]?.trim() || (heading ? `${target} > ${heading}` : target);
      tokens.push({ kind: "wikilink", target, subpath: heading ? `#${heading}` : "", label });
    } else if (m[4] !== undefined) {
      const close = findLinkTargetEnd(text, end);
      if (close === -1 || close === end) {
        // Unclosed or empty "[label](": keep the "[" as text and rescan right after it,
        // so links and URLs in the rest of the text are still rendered.
        pushText(m.index, m.index + 1);
        last = m.index + 1;
        LINK_RE.lastIndex = last;
        continue;
      }
      const target = text.slice(end, close).replace(/\\([()])/g, "$1");
      end = close + 1;
      LINK_RE.lastIndex = end;
      tokens.push({ kind: "link", target, label: m[4] });
    } else if (m[5] !== undefined) {
      tokens.push({ kind: "url", url: m[5] });
    } else if (m[6] !== undefined) {
      tokens.push({ kind: "code", code: m[6] });
    } else if (m[7] !== undefined) {
      tokens.push({ kind: "math", source: m[7].trim(), display: true });
    } else {
      tokens.push({ kind: "math", source: m[8], display: false });
    }
    last = end;
  }
  pushText(last, text.length);
  return tokens;
}

type InlineStyle = "em" | "strong" | "del" | "mark";

// A delimiter that opens or closes an inline style, e.g. the "**" of **bold**.
interface StyleMarker {
  len: number;
  open: boolean;
  style: InlineStyle;
}

// Finds the delimiters of *italic* / _italic_, **bold** / __bold__, ***both***,
// ~~strikethrough~~ and ==highlights==, keyed by their start offset, looking only
// at plain-text ranges (never inside links or inline code). Delimiters have to
// touch the styled text: an opener must be followed by a non-space character and
// a closer preceded by one, so "a * b" or "a == b" stay as they are. "_" also
// doesn't count inside words (snake_case). "~~" and "==" must be exactly two
// characters, "*"/"_" runs at most three. Backslash-escaped delimiters are
// literal, and so is an opener without a matching closer. Styles nest; closing
// a style drops the unclosed openers inside it.
function findStyleMarkers(text: string, tokens: TodoTextToken[]): Map<number, StyleMarker> {
  const markers = new Map<number, StyleMarker>();
  const stack: { pos: number; len: number; ch: string; style: InlineStyle }[] = [];
  const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);
  for (const token of tokens) {
    if (token.kind !== "text") continue;
    for (let i = token.start; i < token.end; i++) {
      const ch = text[i];
      if (ch !== "*" && ch !== "_" && ch !== "~" && ch !== "=") continue;
      let runEnd = i;
      while (runEnd < token.end && text[runEnd] === ch) runEnd++;
      const len = runEnd - i;
      const before = text[i - 1] ?? "";
      const after = text[runEnd] ?? "";
      const pos = i;
      i = runEnd - 1;
      if (before === "\\") continue;
      if (ch === "~" || ch === "=" ? len !== 2 : len > 3) continue;
      let canOpen = after !== "" && !/\s/.test(after);
      let canClose = before !== "" && !/\s/.test(before);
      if (ch === "_") {
        canOpen &&= !isWordChar(before);
        canClose &&= !isWordChar(after);
      }

      if (canClose) {
        // Close the innermost open styles of this delimiter, e.g. "***" closes
        // an open "*" and then an open "**".
        let at = pos;
        let left = len;
        while (left > 0) {
          let idx = stack.length - 1;
          while (idx >= 0 && stack[idx].ch !== ch) idx--;
          if (idx === -1 || stack[idx].len > left) break;
          const opener = stack[idx];
          stack.length = idx;
          markers.set(opener.pos, { len: opener.len, open: true, style: opener.style });
          markers.set(at, { len: opener.len, open: false, style: opener.style });
          at += opener.len;
          left -= opener.len;
        }
        if (left < len) continue;
      }
      if (canOpen) {
        if (ch === "~") stack.push({ pos, len, ch, style: "del" });
        else if (ch === "=") stack.push({ pos, len, ch, style: "mark" });
        else if (len === 3) {
          stack.push({ pos, len: 2, ch, style: "strong" });
          stack.push({ pos: pos + 2, len: 1, ch, style: "em" });
        } else stack.push({ pos, len, ch, style: len === 2 ? "strong" : "em" });
      }
    }
  }
  return markers;
}

// Color emoji that Obsidian (1.14+) treats as part of the opening "==" of a
// highlight, e.g. ==🟢text==. Only the two UTF-16 units right after "==" count.
const HIGHLIGHT_COLORS: Record<string, string> = {
  "🔴": "red", "🟥": "red",
  "🟠": "orange", "🟧": "orange",
  "🟡": "yellow", "🟨": "yellow",
  "🟢": "green", "🟩": "green",
  "🔵": "blue", "🟦": "blue",
  "🟣": "purple", "🟪": "purple",
};

const STYLE_CLASSES: Record<InlineStyle, string> = {
  em: "checklist-inline-italic",
  strong: "checklist-inline-bold",
  del: "checklist-inline-strikethrough",
  mark: "checklist-inline-highlight",
};

// Whether the todo text contains at least one rendered ==highlight==.
function hasHighlight(text: string): boolean {
  for (const marker of findStyleMarkers(text, tokenizeTodoText(text)).values()) {
    if (marker.style === "mark") return true;
  }
  return false;
}

function renderTodoText(
  container: HTMLElement,
  text: string,
  sourcePath: string,
  openLink: (target: string, subpath: string, source: string) => void
): void {
  const tokens = tokenizeTodoText(text);
  const markers = findStyleMarkers(text, tokens);
  const open: HTMLElement[] = [];
  let target = container;
  let hasMath = false;
  for (const token of tokens) {
    switch (token.kind) {
      case "text": {
        let last = token.start;
        for (let i = token.start; i < token.end; i++) {
          const marker = markers.get(i);
          if (!marker) continue;
          if (i > last) target.appendText(text.slice(last, i));
          last = i + marker.len;
          if (marker.open) {
            target = target.createEl(marker.style, { cls: STYLE_CLASSES[marker.style] });
            open.push(target);
            if (marker.style === "mark") {
              const color: string | undefined = HIGHLIGHT_COLORS[text.slice(last, last + 2)];
              if (color) {
                target.setAttr("data-highlight", color);
                last += 2;
              }
            }
          } else {
            open.pop();
            target = open[open.length - 1] ?? container;
          }
          i = last - 1;
        }
        if (token.end > last) target.appendText(text.slice(last, token.end));
        break;
      }
      case "wikilink": {
        const link = target.createEl("a", { cls: "checklist-inline-link", text: token.label });
        link.addEventListener("click", (e) => { e.stopPropagation(); openLink(token.target, token.subpath, sourcePath); });
        break;
      }
      case "link":
        if (isExternalUrl(token.target)) {
          createExternalLink(target, token.label, token.target);
        } else {
          const link = target.createEl("a", { cls: "checklist-inline-link", text: token.label });
          link.addEventListener("click", (e) => { e.stopPropagation(); openLink(token.target, "", sourcePath); });
        }
        break;
      case "url":
        createExternalLink(target, token.url, token.url);
        break;
      case "code":
        target.createEl("code", { cls: "checklist-inline-code", text: token.code });
        break;
      case "math": {
        const math = target.createSpan({ cls: "checklist-inline-math" });
        math.toggleClass("is-display", token.display);
        try {
          const rendered = math.appendChild(renderMath(token.source, token.display));
          // Classes for styles.css, which can't select MathJax's custom elements by tag.
          rendered.addClass("checklist-math-container");
          rendered.querySelector("mjx-math")?.addClass("checklist-math-body");
          hasMath = true;
        } catch {
          // MathJax not available (yet): show the source instead.
          math.setText(token.display ? `$$${token.source}$$` : `$${token.source}$`);
        }
        break;
      }
    }
  }
  if (hasMath) void finishRenderMath();
}


const CONFETTI_COLORS = ["#f94144", "#f3722c", "#f8961e", "#f9c74f", "#90be6d", "#43aa8b", "#577590", "#a8dadc"];

function spawnConfetti(originEl: HTMLElement): void {
  // Skip when the origin is hidden (collapsed sidebar, inactive tab) or the
  // Obsidian window itself isn't focused — the user can't see the animation.
  if (originEl.offsetParent === null) return;
  // Render into the document that actually owns the origin element, so
  // confetti shows up in popout windows too.
  const doc = originEl.ownerDocument;
  if (typeof doc.hasFocus === "function" && !doc.hasFocus()) return;
  const rect = originEl.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 14; i++) {
    const el = doc.body.createDiv({ cls: "checklist-confetti-particle" });
    const size = 5 + Math.random() * 5;
    const angle = (i / 14) * 2 * Math.PI + (Math.random() - 0.5) * 0.4;
    const dist = 28 + Math.random() * 24;
    el.style.cssText = [
      `width:${size}px`,
      `height:${size * (0.4 + Math.random() * 0.6)}px`,
      `left:${cx + Math.cos(angle) * dist}px`,
      `top:${cy + Math.sin(angle) * dist}px`,
      `background:${CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]}`,
      `animation-duration:${380 + Math.random() * 220}ms`,
    ].join(";");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }
}

// Key of a foldable note title (no heading) or heading in the panel.
function foldKey(filePath: string, heading?: string): string {
  return heading === undefined ? filePath : `${filePath}\0${heading}`;
}

// Stable key for a todo: uses text content so it survives line-number shifts.
// Appends a counter to handle duplicate text within the same file.
function itemKey(filePath: string, text: string, occurrence: number): string {
  return occurrence === 0 ? `${filePath}\0${text}` : `${filePath}\0${text}\0${occurrence}`;
}

// Key of a todo row: completed todos (see TodoItem.completed) get their own
// rows, apart from open or just checked-off todos with the same text.
function todoRowKey(todo: TodoItem, occurrence: number): string {
  const key = itemKey(todo.file.path, todo.text, occurrence);
  return todo.completed ? `${key}\0completed` : key;
}

// Occurrence counter base for todoRowKey.
function todoRowBase(todo: TodoItem): string {
  return `${todo.file.path}\0${todo.text}${todo.completed ? "\0completed" : ""}`;
}

class ChecklistView extends ItemView {
  plugin: ChecklistPlugin;

  // Persistent DOM state — survives across renders
  private wrapper: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private rowEls = new Map<string, HTMLElement>();   // itemKey -> row
  private groupEls = new Map<string, { group: HTMLElement; title: HTMLElement }>();
  // Current todo behind each row, refreshed on every reconcile so drops use fresh line indices.
  private rowTodos = new WeakMap<HTMLElement, TodoItem>();
  private dropIndicatorRow: HTMLElement | null = null;
  // Stable display order — only updated on first load or when new file paths appear
  private displayOrder: string[] = [];
  private titleToggleEl: HTMLElement | null = null;
  // Note of the todo being dragged from this view. dataTransfer contents can't be
  // read during dragover, so this decides whether a drop target is allowed.
  private dragSourcePath: string | null = null;

  // Called by the plugin when settings change — resets the stable order so
  // the new sort/filter takes effect on the next render.
  applySettings(): void {
    this.displayOrder = [];
    this.render();
  }

  // Without note titles, todos can only be reordered within their own note:
  // dropping must never move a todo into a different note.
  private canDropInto(filePath: string): boolean {
    return this.plugin.settings.showNoteTitles || this.dragSourcePath === filePath;
  }

  private updateTitleToggle(): void {
    if (!this.titleToggleEl) return;
    const hidden = !this.plugin.settings.showNoteTitles;
    setIcon(this.titleToggleEl, hidden ? "heading" : "list");
    this.titleToggleEl.setAttr("aria-label", hidden ? "Show note titles" : "Hide note titles");
  }

  constructor(leaf: WorkspaceLeaf, plugin: ChecklistPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Checklist"; }
  getIcon(): string { return "check-square"; }
  onOpen(): Promise<void> {
    this.titleToggleEl = this.addAction("list", "Hide note titles", () => {
      void this.plugin.setShowNoteTitles(!this.plugin.settings.showNoteTitles);
    });
    this.render();
    // Cmd+Z (Ctrl+Z on Windows/Linux) while the panel is active undoes the
    // last panel action, also across notes.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", () => {
      void this.plugin.undoLastSidebarAction();
      return false;
    });
    return Promise.resolve();
  }
  onClose(): Promise<void> { return Promise.resolve(); }

  // Confetti for todos checked off outside the panel's checkbox. The rows stay,
  // shown as done, until the todo fades from the panel.
  triggerExternalCompletion(filePath: string, completedTexts: Set<string>): void {
    for (const [key, row] of this.rowEls) {
      const parts = key.split("\0");
      if (parts[0] === filePath && completedTexts.has(parts[1]) && !row.classList.contains("is-done")) {
        const checkbox = row.querySelector<HTMLElement>(".checklist-checkbox");
        if (checkbox) spawnConfetti(checkbox);
      }
    }
  }

  render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    const todos = this.plugin.getAllTodos();

    // ── Empty state ──────────────────────────────────────────────────────────
    if (todos.length === 0) {
      if (this.wrapper) {
        this.wrapper.remove();
        this.wrapper = null;
        this.rowEls.clear();
        this.groupEls.clear();
        this.displayOrder = [];
      }
      this.updateTitleToggle();
      const emptyText = this.plugin.getEmptyMessage();
      if (!this.emptyEl) {
        this.emptyEl = container.createDiv({ cls: "checklist-empty", text: emptyText });
      } else {
        this.emptyEl.setText(emptyText);
      }
      return;
    }
    if (this.emptyEl) { this.emptyEl.remove(); this.emptyEl = null; }
    if (!this.wrapper) {
      this.wrapper = container.createDiv({ cls: "checklist-container" });
    }
    this.wrapper.classList.toggle("is-bare", !this.plugin.settings.showNoteTitles);
    this.wrapper.classList.toggle("has-headings", this.plugin.settings.showHeadings);
    this.updateTitleToggle();

    // ── Build grouped items ───────────────────────────────────────────────────
    const grouped = new Map<string, TodoItem[]>();
    for (const todo of todos) {
      if (!grouped.has(todo.file.path)) grouped.set(todo.file.path, []);
      grouped.get(todo.file.path)!.push(todo);
    }

    // ── Determine display order of note groups (not individual todos) ────────
    if (this.plugin.settings.sortMode === "alpha" || this.plugin.settings.sortMode === "alpha-desc") {
      this.displayOrder = [...grouped.keys()].sort((a, b) =>
        compareNoteGroups(grouped.get(a)![0].file, grouped.get(b)![0].file, this.plugin.settings.sortMode)
      );
    } else if (this.plugin.settings.sortMode === "oldest") {
      // Stable order — keep existing positions, append new note groups by oldest mtime first.
      this.displayOrder = this.displayOrder.filter(p => grouped.has(p));
      const newPaths = [...grouped.keys()]
        .filter(p => !this.displayOrder.includes(p))
        .sort((a, b) =>
          compareNoteGroups(grouped.get(a)![0].file, grouped.get(b)![0].file, "oldest")
        );
      this.displayOrder = [...this.displayOrder, ...newPaths];
    } else {
      // Recent: stable order — keep existing positions, prepend new files
      // sorted by mtime (newest first). Prevents the list from jumping when
      // a file's mtime updates from completing a todo.
      this.displayOrder = this.displayOrder.filter(p => grouped.has(p));
      const newPaths = [...grouped.keys()]
        .filter(p => !this.displayOrder.includes(p))
        .sort((a, b) =>
          compareNoteGroups(grouped.get(a)![0].file, grouped.get(b)![0].file, "recent")
        );
      this.displayOrder = [...newPaths, ...this.displayOrder];
    }
    // ── Pinned groups float to the top, in pin order; the rest keep their order.
    const pinned = this.plugin.settings.pinnedPaths;
    const folded = new Set(this.plugin.settings.foldedKeys);
    const orderedPaths = pinned.some(p => grouped.has(p))
      ? [
          ...pinned.filter(p => grouped.has(p)),
          ...this.displayOrder.filter(p => !pinned.includes(p)),
        ]
      : this.displayOrder;

    // ── Remove stale groups ───────────────────────────────────────────────────
    for (const [path, { group }] of this.groupEls) {
      if (!grouped.has(path)) {
        group.remove();
        this.groupEls.delete(path);
      }
    }

    // ── Build text-based keys for all live todos ──────────────────────────────
    // Key by text content (stable across line-number shifts from insertions).
    // Track occurrence count per (file, text) pair to handle duplicates.
    const occurrences = new Map<string, number>();
    const todoKeys = todos.map(t => {
      const base = todoRowBase(t);
      const occ = occurrences.get(base) ?? 0;
      occurrences.set(base, occ + 1);
      return todoRowKey(t, occ);
    });
    const liveKeys = new Set(todoKeys);

    // ── Remove stale rows ─────────────────────────────────────────────────────
    for (const [key, row] of this.rowEls) {
      if (!liveKeys.has(key)) {
        row.remove();
        this.rowEls.delete(key);
      }
    }

    // ── Remove old dividers (stateless, re-inserted below) ───────────────────
    this.wrapper.querySelectorAll(".checklist-divider, .checklist-heading").forEach(d => d.remove());

    // ── Reconcile groups + items in desired order ─────────────────────────────
    for (let gi = 0; gi < orderedPaths.length; gi++) {
      const filePath = orderedPaths[gi];
      const items = grouped.get(filePath)!;

      if (gi > 0) this.wrapper.appendChild(createDiv({ cls: "checklist-divider" }));

      // Get or create group element
      let groupData = this.groupEls.get(filePath);
      if (!groupData) {
        const group = createDiv({ cls: "checklist-group" });
        const header = group.createDiv({ cls: "checklist-group-header" });
        this.buildFoldToggle(header, foldKey(filePath));
        const title = header.createDiv({ cls: "checklist-group-title", text: items[0].file.basename });
        const titleFile = items[0].file;
        title.addEventListener("click", () => { void this.plugin.navigateToFile(titleFile); });

        const pin = header.createDiv({ cls: "checklist-group-pin" });
        setIcon(pin, "pin");
        pin.setAttr("aria-label", "Pin to top");
        pin.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation();
          void this.plugin.togglePin(filePath).then(() => this.plugin.refreshView());
        });

        groupData = { group, title };
        this.groupEls.set(filePath, groupData);
        this.setupGroupDrop(group, items[0].file);
      } else {
        groupData.title.setText(items[0].file.basename);
      }

      groupData.group.classList.toggle("is-pinned", pinned.includes(filePath));
      groupData.group.classList.toggle("is-folded", folded.has(foldKey(filePath)));
      this.wrapper.appendChild(groupData.group);

      // Reconcile items using text-based keys
      const fileOccurrences = new Map<string, number>();
      let currentHeading: string | undefined;
      let headingFolded = false;
      for (const todo of items) {
        if (this.plugin.settings.showHeadings && todo.heading?.text !== currentHeading) {
          currentHeading = todo.heading?.text;
          headingFolded = currentHeading !== undefined && folded.has(foldKey(filePath, currentHeading));
          if (todo.heading) this.buildHeading(groupData.group, todo.file, todo.heading, headingFolded);
        }
        const base = todoRowBase(todo);
        const occ = fileOccurrences.get(base) ?? 0;
        fileOccurrences.set(base, occ + 1);
        const key = todoRowKey(todo, occ);

        let row = this.rowEls.get(key);
        if (!row) {
          row = this.buildRow(todo, groupData.group, key, occ);
          this.rowEls.set(key, row);
        }
        // Set on every reconcile so re-indenting a todo in the note updates the row.
        row.style.setProperty("--checklist-depth", String(todo.depth ?? 0));
        row.classList.toggle("is-done", !!todo.done);
        row.classList.toggle("is-completed", !!todo.completed);
        row.draggable = !todo.done;
        row.classList.toggle("is-folded", headingFolded);
        this.rowTodos.set(row, todo);
        groupData.group.appendChild(row);
      }
    }
  }

  private parseDragPayload(e: DragEvent): DragTodoPayload | null {
    const raw = e.dataTransfer?.getData(DRAG_MIME);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isDragTodoPayload(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private payloadToTodo(payload: DragTodoPayload): TodoItem | null {
    const file = this.plugin.app.vault.getAbstractFileByPath(payload.sourcePath);
    if (!(file instanceof TFile)) return null;
    return { file, lineIndex: payload.lineIndex, text: payload.text };
  }

  // Where a drop over `groupEl` lands: before or after one of its rows, picked
  // by which half of the row the pointer is over. Over the group header or
  // empty space it means after the last row. "After" a row is normalised to
  // "before the next row" so the indicator line and the insert position match
  // even when the next row is a nested child. Returns null when the drop would
  // leave the dragged todo where it is.
  private getDropTarget(groupEl: HTMLElement, e: DragEvent): { row: HTMLElement; after: boolean } | null {
    // Completed todos at the bottom of the note aren't drop targets.
    const rows = Array.from(groupEl.querySelectorAll<HTMLElement>(":scope > .checklist-item:not(.is-completed)"));
    if (rows.length === 0) return null;
    const node = e.targetNode;
    const el = node?.instanceOf(HTMLElement) ? node : null;
    // A heading label counts as the top of the row below it.
    const over = el?.closest<HTMLElement>(".checklist-item")
      ?? el?.closest(".checklist-heading")?.nextElementSibling as HTMLElement | null | undefined;
    let index = over ? rows.indexOf(over) : -1;
    let after = true;
    if (index < 0) {
      index = rows.length - 1;
    } else {
      const rect = rows[index].getBoundingClientRect();
      after = e.clientY > rect.top + rect.height / 2;
    }
    if (after && index + 1 < rows.length) {
      index++;
      after = false;
    }

    // Same note: dropping onto the dragged todo itself or inside its nested
    // children does nothing. Right after its children it only matters if the
    // todo would be re-indented (it takes the indentation of the next row).
    const dragged = rows.findIndex((r) => r.classList.contains("checklist-item-dragging"));
    if (dragged >= 0) {
      const depthOf = (i: number) => this.rowTodos.get(rows[i])?.depth ?? 0;
      let blockEnd = dragged + 1;
      while (blockEnd < rows.length && depthOf(blockEnd) > depthOf(dragged)) blockEnd++;
      const insertAt = after ? rows.length : index;
      if (insertAt >= dragged && insertAt < blockEnd) return null;
      if (insertAt === blockEnd && (after || depthOf(index) === depthOf(dragged))) return null;
    }
    return { row: rows[index], after };
  }

  // Shows the drop position as an accent line on the row's top or bottom edge
  // (drawn with a pseudo-element, so nothing shifts). null hides it.
  private showDropIndicator(target: { row: HTMLElement; after: boolean } | null): void {
    if (this.dropIndicatorRow && this.dropIndicatorRow !== target?.row) {
      this.dropIndicatorRow.classList.remove("checklist-drop-before", "checklist-drop-after");
    }
    this.dropIndicatorRow = target?.row ?? null;
    if (target) {
      target.row.classList.toggle("checklist-drop-before", !target.after);
      target.row.classList.toggle("checklist-drop-after", target.after);
    }
  }

  private setupGroupDrop(groupEl: HTMLElement, targetFile: TFile): void {
    groupEl.addEventListener("dragover", (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
      if (!this.canDropInto(targetFile.path)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      this.showDropIndicator(this.getDropTarget(groupEl, e));
    });
    groupEl.addEventListener("dragleave", (e: DragEvent) => {
      if (!groupEl.contains(e.relatedTarget as Node)) this.showDropIndicator(null);
    });
    groupEl.addEventListener("drop", (e: DragEvent) => {
      const target = this.getDropTarget(groupEl, e);
      this.showDropIndicator(null);
      const payload = this.parseDragPayload(e);
      if (!payload) return;
      // Without note titles, a todo may only be reordered within its own note.
      if (!this.plugin.settings.showNoteTitles && payload.sourcePath !== targetFile.path) return;
      e.preventDefault();
      e.stopPropagation();
      const todo = this.payloadToTodo(payload);
      const anchor = target ? this.rowTodos.get(target.row) : undefined;
      if (!todo || !target || !anchor) return;
      this.plugin.suppressRefresh = true;
      void this.plugin.moveTodo(todo, targetFile, { todo: anchor, after: target.after }).then(() => {
        this.plugin.suppressRefresh = false;
        this.plugin.refreshView();
      });
    });
  }

  // Arrow left of a note title or heading that folds the todos below it.
  private buildFoldToggle(parent: HTMLElement, key: string): void {
    const toggle = parent.createDiv({ cls: "checklist-fold-toggle" });
    setIcon(toggle, "chevron-down");
    toggle.setAttr("aria-label", "Fold");
    toggle.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      void this.plugin.toggleFold(key).then(() => this.render());
    });
  }

  private buildHeading(groupEl: HTMLElement, file: TFile, heading: TodoHeading, folded: boolean): void {
    const el = groupEl.createDiv({ cls: "checklist-heading" });
    el.classList.toggle("is-folded", folded);
    this.buildFoldToggle(el, foldKey(file.path, heading.text));
    renderTodoText(el, heading.text, file.path, (target, subpath, source) => {
      void this.plugin.app.workspace.openLinkText(target + subpath, source, false);
    });
    el.addEventListener("click", (e: MouseEvent) => {
      const target = e.targetNode;
      if (!target?.instanceOf(HTMLElement) || !target.classList.contains("checklist-inline-link")) {
        void this.plugin.navigateToLine(file, heading.line);
      }
    });
  }

  private buildRow(todo: TodoItem, groupEl: HTMLElement, key: string, occurrence: number): HTMLElement {
    const row = createDiv({ cls: "checklist-item" });

    const checkbox = row.createDiv({ cls: "checklist-checkbox" });
    let toggling = false;
    // Checking off keeps the row, greyed out, until it fades from the panel;
    // clicking it again in the meantime unchecks the todo.
    checkbox.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      if (toggling) return;
      toggling = true;
      const current = this.rowTodos.get(row) ?? todo;
      row.classList.toggle("is-done", !current.done);
      if (!current.done) spawnConfetti(checkbox);
      this.plugin.suppressRefresh = true;
      const action = current.done ? this.plugin.reopenTodo(current) : this.plugin.completeTodo(current);
      void action.then(() => {
        toggling = false;
        this.plugin.suppressRefresh = false;
        this.plugin.refreshView();
      });
    });

    const text = row.createDiv({ cls: "checklist-text" });
    renderTodoText(text, todo.text, todo.file.path, (target, subpath, source) => {
      void this.plugin.app.workspace.openLinkText(target + subpath, source, false);
    });
    text.addEventListener("click", (e: MouseEvent) => {
      const target = e.targetNode;
      if (!target?.instanceOf(HTMLElement) || !target.classList.contains("checklist-inline-link")) {
        void this.plugin.navigateToTodo(this.rowTodos.get(row) ?? todo);
      }
    });

    const trash = row.createDiv({ cls: "checklist-trash" });
    setIcon(trash, "trash");
    let deleting = false;
    trash.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      if (deleting) return;
      deleting = true;
      this.plugin.suppressRefresh = true;
      void this.plugin.deleteTodo(todo).then(() => {
        row.remove();
        this.rowEls.delete(key);
        if (!groupEl.querySelector(".checklist-item")) {
          groupEl.remove();
          this.groupEls.delete(todo.file.path);
        }
        this.plugin.suppressRefresh = false;
        this.plugin.refreshView();
      });
    });

    row.addEventListener("mouseenter", () => this.plugin.setHoveredTodo(this.rowTodos.get(row) ?? todo));
    row.addEventListener("mouseleave", () => this.plugin.setHoveredTodo(null));

    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", (e: DragEvent) => {
      e.dataTransfer?.setData(
        DRAG_MIME,
        JSON.stringify({
          sourcePath: todo.file.path,
          text: todo.text,
          lineIndex: todo.lineIndex,
          occurrence,
        } satisfies DragTodoPayload)
      );
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.classList.add("checklist-item-dragging");
      this.dragSourcePath = todo.file.path;
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("checklist-item-dragging");
      this.dragSourcePath = null;
      this.showDropIndicator(null);
    });

    return row;
  }
}

// Countdown until a done todo leaves the panel. `timer` is null while the
// todo is hovered.
interface DoneTimer {
  timer: number | null;
}

// A checked-off todo shown by "Show completed todos": its "- [x]" line, and
// when it was checked off (unknown for older ones, shown only with "All").
interface CompletedTodo {
  lineIndex: number;
  text: string;
  at?: number;
}

export default class ChecklistPlugin extends Plugin {
  private index: Map<string, Array<{ lineIndex: number; text: string; indent: number; heading?: TodoHeading; done?: boolean }>> = new Map();
  // Every "- [x]" line per note, and the notes containing each done text.
  private doneIndex = new Map<string, Array<{ lineIndex: number; text: string; heading?: TodoHeading }>>();
  private doneTextPaths = new Map<string, Set<string>>();
  // Saves completion records relinked while rendering (see resolveCompletedTodos).
  private requestSaveCompletions = debounce(() => { void this.saveSettings(); }, 1000, true);
  // Recently checked-off todo texts per note, with the timer that drops them
  // from the panel. Their "- [x]" lines are indexed as done until then.
  private recentlyDone = new Map<string, Map<string, DoneTimer>>();
  // Todo under the mouse in the panel; a done one doesn't fade while hovered.
  private hoveredTodo: { path: string; text: string } | null = null;
  suppressRefresh = false;
  settings: ChecklistSettings = { ...DEFAULT_SETTINGS };
  private writeQueue: Promise<void> = Promise.resolve();
  // Tracks the last content we processed per file so editor-change and vault-modify don't double-fire
  private lastProcessedContent = new Map<string, string>();
  private undoStack: UndoFn[] = [];
  private suppressRollOverOnCreate = false;
  // Note or folder the panel was last rendered for (see getScopeKey).
  private renderedScopeKey: string | null = null;
  // Markdown note the note/folder scope is based on. Kept while a non-Markdown
  // file (PDF, canvas, image) is active.
  private scopeNote: TFile | null = null;

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn);
    return this.writeQueue;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as
      (Partial<ChecklistSettings> & { excludeKeywords?: string; hideNoteTitles?: boolean }) | null;
    const { excludeKeywords, hideNoteTitles, ...rest } = stored ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...rest };
    // Up to 1.10.x, the setting was inverted as "Hide note titles".
    if (rest.showNoteTitles === undefined && hideNoteTitles !== undefined) {
      this.settings.showNoteTitles = !hideNoteTitles;
    }
    if (!isTodoScope(this.settings.todoScope)) this.settings.todoScope = "vault";
    if (!isCompletedRange(this.settings.showCompleted)) this.settings.showCompleted = "none";
    this.settings.completions = Array.isArray(rest.completions) ? rest.completions.filter(isCompletionRecord) : [];
    this.pruneCompletions();
    // Up to 1.10.x, exclusions were a comma-separated keyword list. Carry them
    // over as one keyword per line.
    if (rest.excludeRules === undefined && excludeKeywords) {
      this.settings.excludeRules = excludeKeywords
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .join("\n");
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    void loadMathJax();
    this.registerView(VIEW_TYPE, (leaf) => new ChecklistView(leaf, this));
    this.addRibbonIcon("check-square", "Open Checklist", () => { void this.activateView(); });
    this.addCommand({ id: "open-checklist", name: "Open Checklist panel", callback: () => { void this.activateView(); } });
    this.addCommand({
      id: "toggle-note-titles",
      name: "Toggle note titles in Checklist panel",
      callback: () => { void this.setShowNoteTitles(!this.settings.showNoteTitles); },
    });
    this.addSettingTab(new ChecklistSettingTab(this.app, this));
    this.register(() => {
      for (const path of [...this.recentlyDone.keys()]) this.forgetDone(path);
    });
    // Completed todos shown for "Today", "This week", … drop out as time passes.
    this.registerInterval(window.setInterval(() => {
      const range = this.settings.showCompleted;
      if (range !== "none" && range !== "all") this.refreshView();
    }, 60 * 1000));

    this.app.workspace.onLayoutReady(async () => {
      await this.buildIndex();
      this.refreshView();
    });

    // getActiveFile retains the most recently active file while the sidebar
    // has focus. Both events cover switching tabs and opening in the same tab.
    // Re-render only when the note or folder in scope actually changed.
    const refreshScope = () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) this.scopeNote = null;
      else if (file.extension === "md") this.scopeNote = file;
      if (this.settings.todoScope === "vault") return;
      if (this.getScopeKey() !== this.renderedScopeKey) this.refreshView();
    };
    this.registerEvent(this.app.workspace.on("file-open", refreshScope));
    this.registerEvent(this.app.workspace.on("active-leaf-change", refreshScope));

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (!this.settings.movePastTodosToToday) return;
        if (this.suppressRollOverOnCreate) return;
        if (!this.isTodayDateNote(file)) return;
        void this.migratePastTodosToToday(file);
      })
    );

    // Detect checkbox toggles immediately as the user types/presses Cmd+L
    this.registerEvent(this.app.workspace.on("editor-change", (editor, view) => {
      if (!(view instanceof MarkdownView) || !view.file) return;
      const file = view.file;
      const content = editor.getValue();
      // Skip if we already processed this exact content (avoids double-fire with vault modify)
      if (this.lastProcessedContent.get(file.path) === content) return;
      this.handleContentChange(file, content);
    }));

    this.registerEvent(this.app.vault.on("modify", async (file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      const content = await this.app.vault.cachedRead(file);
      // Skip if editor-change already processed this content
      if (this.lastProcessedContent.get(file.path) === content) return;
      this.handleContentChange(file, content);
    }));

    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) {
        this.index.delete(file.path);
        this.setDoneLines(file.path, []);
        this.forgetDone(file.path);
        this.lastProcessedContent.delete(file.path);
        this.refreshView();
      }
    }));

    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") {
        this.index.delete(oldPath);
        this.setDoneLines(oldPath, []);
        this.forgetDone(oldPath);
        // Completed todos move along with their note.
        let moved = false;
        for (const record of this.settings.completions) {
          if (record.path === oldPath) {
            record.path = file.path;
            moved = true;
          }
        }
        if (moved) void this.saveSettings();
        await this.updateIndex(file);
        this.refreshView();
      }
    }));
  }

  async buildIndex(): Promise<void> {
    this.index.clear();
    await Promise.all(this.app.vault.getMarkdownFiles().map(f => this.updateIndex(f)));
  }

  async updateIndex(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    this.indexContent(file.path, content);
  }

  private indexContent(filePath: string, content: string): void {
    const todos: Array<{ lineIndex: number; text: string; indent: number; heading?: TodoHeading; done?: boolean }> = [];
    const doneLines: Array<{ lineIndex: number; text: string; heading?: TodoHeading }> = [];
    const recentlyDone = this.recentlyDone.get(filePath);
    let heading: TodoHeading | undefined;
    content.split("\n").forEach((line, i) => {
      const headingMatch = line.match(HEADING_RE);
      if (headingMatch) heading = { text: headingMatch[1].trimEnd(), line: i };
      const m = line.match(TODO_OPEN_RE);
      if (m) todos.push({ lineIndex: i, text: m[1], indent: listIndentWidth(line), heading });
      const d = line.match(TODO_DONE_RE);
      if (!d) return;
      doneLines.push({ lineIndex: i, text: d[1], heading });
      if (recentlyDone?.has(d[1])) {
        todos.push({ lineIndex: i, text: d[1], indent: listIndentWidth(line), heading, done: true });
      }
    });
    if (todos.length > 0) this.index.set(filePath, todos);
    else this.index.delete(filePath);
    this.setDoneLines(filePath, doneLines);
  }

  private setDoneLines(filePath: string, lines: Array<{ lineIndex: number; text: string; heading?: TodoHeading }>): void {
    for (const { text } of this.doneIndex.get(filePath) ?? []) {
      const paths = this.doneTextPaths.get(text);
      paths?.delete(filePath);
      if (paths?.size === 0) this.doneTextPaths.delete(text);
    }
    if (lines.length === 0) {
      this.doneIndex.delete(filePath);
      return;
    }
    this.doneIndex.set(filePath, lines);
    for (const { text } of lines) {
      let paths = this.doneTextPaths.get(text);
      if (!paths) this.doneTextPaths.set(text, (paths = new Set()));
      paths.add(filePath);
    }
  }

  private pruneCompletions(): void {
    const cutoff = Date.now() - COMPLETION_RETENTION_MS;
    this.settings.completions = this.settings.completions.filter((r) => r.at >= cutoff);
  }

  // Keeps the completion records of a note in step with an edit of it, given
  // the open and done todo texts (with counts) before and after. A note can
  // only hold as many records for a text as it has "- [x]" lines with it; the
  // newest records beyond that are dropped if the todo was unchecked, follow
  // the text if a done todo was edited, and otherwise (deleted or moved to
  // another note) are left to resolveCompletedTodos, which relinks them to
  // the note the line turns up in. `completed` are the todos just checked off.
  private updateCompletions(
    filePath: string,
    oldOpen: Map<string, number>,
    newOpen: Map<string, number>,
    oldDone: Map<string, number>,
    newDone: Map<string, number>,
    completed: Set<string>,
  ): void {
    // Records of `text` in this note beyond its done lines, newest first.
    const excess = (text: string) => {
      const own = this.settings.completions.filter((r) => r.path === filePath && r.text === text).sort((a, b) => b.at - a.at);
      return own.slice(0, Math.max(0, own.length - (newDone.get(text) ?? 0)));
    };
    let changed = false;
    const lost: string[] = [];
    for (const [text, count] of oldDone) {
      if ((newDone.get(text) ?? 0) >= count) continue;
      if ((newOpen.get(text) ?? 0) > (oldOpen.get(text) ?? 0)) {
        const drop = new Set(excess(text));
        if (drop.size > 0) {
          this.settings.completions = this.settings.completions.filter((r) => !drop.has(r));
          changed = true;
        }
      } else {
        lost.push(text);
      }
    }
    const gained = [...newDone].filter(([text, count]) => count > (oldDone.get(text) ?? 0) && !completed.has(text));
    // One done todo's text changed: its record follows the new text.
    if (lost.length === 1 && gained.length === 1) {
      for (const record of excess(lost[0])) {
        record.text = gained[0][0];
        changed = true;
      }
    }
    if (completed.size > 0) {
      const now = Date.now();
      for (const text of completed) {
        // The note's other "- [x]" lines with this text keep at most one record each.
        const own = this.settings.completions
          .filter((r) => r.path === filePath && r.text === text)
          .sort((a, b) => b.at - a.at);
        const stale = new Set(own.slice(Math.max(0, (newDone.get(text) ?? 1) - 1)));
        this.settings.completions = this.settings.completions.filter((r) => !stale.has(r));
        this.settings.completions.push({ path: filePath, text, at: now });
      }
      this.pruneCompletions();
      changed = true;
    }
    if (changed) void this.saveSettings();
  }

  // Matches the completion records to the "- [x]" lines they belong to and
  // returns, per note, the checked-off todos "Show completed todos" shows,
  // most recently checked off first. A record whose note no longer has its
  // line (the todo was moved, or its note renamed outside Obsidian) is
  // relinked to another note with an unmatched done line of the same text that
  // was modified since (so a deleted todo doesn't take over an older one).
  private resolveCompletedTodos(): Map<string, CompletedTodo[]> {
    const shown = new Map<string, CompletedTodo[]>();
    const range = this.settings.showCompleted;
    if (range === "none") return shown;
    const since = completedSince(range);
    // Unmatched done lines per note and text, in line order.
    const free = new Map<string, Map<string, number[]>>();
    const freeLines = (path: string, text: string): number[] => {
      let byText = free.get(path);
      if (!byText) {
        free.set(path, (byText = new Map<string, number[]>()));
        for (const { lineIndex, text: t } of this.doneIndex.get(path) ?? []) {
          if (!byText.has(t)) byText.set(t, []);
          byText.get(t)!.push(lineIndex);
        }
      }
      return byText.get(text) ?? [];
    };
    const show = (path: string, item: CompletedTodo) => {
      if (!shown.has(path)) shown.set(path, []);
      shown.get(path)!.push(item);
    };
    const claim = (record: CompletionRecord, lines: number[]) => {
      const lineIndex = lines.shift()!;
      if (since === null || record.at >= since) show(record.path, { lineIndex, text: record.text, at: record.at });
    };

    const records = [...this.settings.completions].sort((a, b) => b.at - a.at);
    const orphans: CompletionRecord[] = [];
    for (const record of records) {
      const lines = freeLines(record.path, record.text);
      if (lines.length > 0) claim(record, lines);
      else orphans.push(record);
    }
    let relinked = false;
    for (const record of orphans) {
      for (const path of this.doneTextPaths.get(record.text) ?? []) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.stat.mtime < record.at) continue;
        const lines = freeLines(path, record.text);
        if (lines.length === 0) continue;
        record.path = path;
        relinked = true;
        claim(record, lines);
        break;
      }
    }
    if (relinked) this.requestSaveCompletions();

    // "All" also shows todos checked off before they were recorded.
    if (since === null) {
      for (const [path, lines] of this.doneIndex) {
        const unrecorded = lines.filter(({ lineIndex, text }) => freeLines(path, text).includes(lineIndex));
        for (const { lineIndex, text } of unrecorded) show(path, { lineIndex, text });
      }
    }
    return shown;
  }

  // Keeps just checked-off todos in the panel for DONE_LINGER_MS (restarting
  // the timer for ones already there). Call indexContent afterwards.
  private markDone(filePath: string, texts: Iterable<string>): void {
    let entries = this.recentlyDone.get(filePath);
    if (!entries) this.recentlyDone.set(filePath, (entries = new Map<string, DoneTimer>()));
    for (const text of texts) {
      const old = entries.get(text);
      if (old?.timer != null) window.clearTimeout(old.timer);
      const entry: DoneTimer = { timer: null };
      entries.set(text, entry);
      if (!this.isHovered(filePath, text)) this.startDoneTimer(filePath, text, entry);
    }
  }

  private startDoneTimer(filePath: string, text: string, entry: DoneTimer): void {
    entry.timer = window.setTimeout(() => {
      this.forgetDone(filePath, [text]);
      const items = this.index.get(filePath)?.filter((t) => !(t.done && t.text === text));
      if (items && items.length > 0) this.index.set(filePath, items);
      else this.index.delete(filePath);
      this.refreshView();
    }, DONE_LINGER_MS);
  }

  private isHovered(filePath: string, text: string): boolean {
    return this.hoveredTodo?.path === filePath && this.hoveredTodo.text === text;
  }

  // Called by the view on mouseenter (todo) and mouseleave (null). A done todo
  // stops fading while hovered and starts the full countdown again afterwards.
  setHoveredTodo(todo: TodoItem | null): void {
    const prev = this.hoveredTodo;
    if (prev) {
      const entry = this.recentlyDone.get(prev.path)?.get(prev.text);
      if (entry && entry.timer === null) this.startDoneTimer(prev.path, prev.text, entry);
    }
    this.hoveredTodo = todo ? { path: todo.file.path, text: todo.text } : null;
    const entry = todo && this.recentlyDone.get(todo.file.path)?.get(todo.text);
    if (entry && entry.timer !== null) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private forgetDone(filePath: string, texts?: Iterable<string>): void {
    const entries = this.recentlyDone.get(filePath);
    if (!entries) return;
    for (const text of texts ?? [...entries.keys()]) {
      const entry = entries.get(text);
      if (entry?.timer != null) window.clearTimeout(entry.timer);
      entries.delete(text);
    }
    if (entries.size === 0) this.recentlyDone.delete(filePath);
  }

  // Processes content written by the panel right away, so the view doesn't
  // render before the editor-change/modify event updates the index.
  private syncContent(file: TFile, content: string): void {
    if (this.lastProcessedContent.get(file.path) !== content) this.handleContentChange(file, content);
  }

  private handleContentChange(file: TFile, content: string): void {
    const oldTodos = (this.index.get(file.path) ?? []).filter(t => !t.done);
    const oldDone = countTexts(this.doneIndex.get(file.path));
    this.lastProcessedContent.set(file.path, content);
    this.indexContent(file.path, content);
    const newOpen = (this.index.get(file.path) ?? []).filter(t => !t.done);
    const newTexts = new Set(newOpen.map(t => t.text));
    // Todos unchecked again no longer linger as done.
    const reopened = [...(this.recentlyDone.get(file.path)?.keys() ?? [])].filter(t => newTexts.has(t));
    if (reopened.length > 0) {
      this.forgetDone(file.path, reopened);
      this.indexContent(file.path, content);
    }

    const completedTexts = new Set<string>();
    // Text of the "- [x]" lines of those todos, which other plugins may have
    // extended (e.g. a completion date).
    const completedLines = new Set<string>();
    if (oldTodos.length > 0) {
      const lines = content.split("\n");
      for (const old of oldTodos) {
        if (!newTexts.has(old.text)) {
          const lo = Math.max(0, old.lineIndex - 2);
          const hi = Math.min(lines.length - 1, old.lineIndex + 2);
          for (let i = lo; i <= hi; i++) {
            if (TODO_DONE_PREFIX.test(lines[i]) && lines[i].includes(old.text)) {
              completedTexts.add(old.text);
              completedLines.add(lines[i].match(TODO_DONE_RE)?.[1] ?? old.text);
              break;
            }
          }
        }
      }
    }

    this.updateCompletions(file.path, countTexts(oldTodos), countTexts(newOpen), oldDone, countTexts(this.doneIndex.get(file.path)), completedLines);

    if (completedTexts.size > 0) {
      // Shown below the note's todos right away when completed todos are
      // shown; otherwise they linger in place and fade.
      if (this.settings.showCompleted === "none") {
        this.markDone(file.path, completedTexts);
        this.indexContent(file.path, content);
      }
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
        if (leaf.view instanceof ChecklistView) leaf.view.triggerExternalCompletion(file.path, completedTexts);
      });
    }

    if (!this.suppressRefresh) this.refreshView();
  }

  getAllTodos(): TodoItem[] {
    const todos: TodoItem[] = [];
    const activeNote = this.getScopeNote();
    const scope = this.settings.todoScope;
    this.renderedScopeKey = this.getScopeKey();
    if (scope !== "vault" && !activeNote) return todos;
    const folder = activeNote?.path.slice(0, activeNote.path.lastIndexOf("/") + 1) ?? "";
    // Resolve the date format once if any date-based filter is active.
    const needsFormat = this.settings.dateNotesOnly || this.settings.hideFutureDateNotes;
    const format = needsFormat ? this.getDateNotesFormat() : null;
    const exclude = parseExcludeRules(this.settings.excludeRules);
    const completed = this.resolveCompletedTodos();
    for (const path of new Set([...this.index.keys(), ...completed.keys()])) {
      const items = this.index.get(path) ?? [];
      if (scope === "note" && path !== activeNote?.path) continue;
      if (scope === "folder" && !path.startsWith(folder)) continue;
      if (isNoteExcluded(path, exclude)) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      if (this.settings.dateNotesOnly && format !== null && !this.isDateNote(file, format)) continue;
      // Hide date notes dated after today (e.g. planning ahead in future daily notes).
      if (this.settings.hideFutureDateNotes && format !== null && this.isFutureDateNote(file, format)) continue;
      // Derive each todo's nesting level from the relative indentation of the
      // todos in this file (in line order), so it mirrors the note structure
      // regardless of whether the note indents with tabs, 2 or 4 spaces.
      const stack: number[] = [];
      const noteTodos: TodoItem[] = [];
      for (const item of items) {
        while (stack.length > 0 && stack[stack.length - 1] >= item.indent) stack.pop();
        const depth = stack.length;
        stack.push(item.indent);
        if (isTodoExcluded(item.text, exclude)) continue;
        noteTodos.push({ file, lineIndex: item.lineIndex, text: item.text, depth, heading: item.heading, done: item.done });
      }
      // Priority-sort within the note, per indentation level, keeping each
      // item's nested children with it. The view groups by note path and
      // orders the note groups itself, so todos only need to be contiguous and
      // correctly ordered within their own note here.
      const open = this.settings.showHeadings ? sortTodosWithinHeadings(noteTodos) : sortTodosByPriority(noteTodos);
      // Checked-off todos follow the open ones (of their heading, if headings
      // are shown), most recently checked off first.
      const headings = new Map((this.doneIndex.get(path) ?? []).map((l) => [l.lineIndex, l.heading]));
      const done: TodoItem[] = (completed.get(path) ?? [])
        .filter((c) => !isTodoExcluded(c.text, exclude))
        .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.lineIndex - b.lineIndex)
        .map((c) => ({ file, lineIndex: c.lineIndex, text: c.text, heading: headings.get(c.lineIndex), done: true, completed: true }));
      todos.push(...(this.settings.showHeadings ? mergeUnderHeadings(open, done) : [...open, ...done]));
    }
    return todos;
  }

  private getScopeNote(): TFile | null {
    const active = this.app.workspace.getActiveFile();
    const file = this.scopeNote ?? (active?.extension === "md" ? active : null);
    return file && this.app.vault.getAbstractFileByPath(file.path) === file ? file : null;
  }

  // Identifies what the current scope shows: the note path, or the folder prefix.
  private getScopeKey(): string {
    const scope = this.settings.todoScope;
    const note = this.getScopeNote();
    if (scope === "vault" || !note) return scope;
    const path = scope === "note" ? note.path : note.path.slice(0, note.path.lastIndexOf("/") + 1);
    return `${scope}\0${path}`;
  }

  getEmptyMessage(): string {
    if (this.settings.todoScope !== "vault" && !this.getScopeNote()) {
      return "Open a Markdown note to show its todos.";
    }
    const hasFilters =
      this.settings.dateNotesOnly ||
      this.settings.hideFutureDateNotes ||
      hasExcludeRules(parseExcludeRules(this.settings.excludeRules));
    if (hasFilters) return "No open todos match the current filters.";
    if (this.settings.todoScope === "note") return "No open todos in the current note.";
    if (this.settings.todoScope === "folder") return "No open todos in the current folder or its subfolders.";
    return "No open todos.";
  }

  private getDailyNotesPlugin(): DailyNotesPluginInstance | null {
    const container = (this.app as unknown as AppWithInternalPlugins).internalPlugins;
    return container?.getPluginById("daily-notes")?.instance ?? null;
  }

  // Reads the Daily Notes core plugin's date format, falling back to the
  // Obsidian default. Returning a string keeps the call site simple.
  private getDateNotesFormat(): string {
    const fmt = this.getDailyNotesPlugin()?.options?.format;
    return typeof fmt === "string" && fmt.length > 0 ? fmt : "YYYY-MM-DD";
  }

  private async getOrCreateTodayNote(): Promise<TFile | null> {
    const daily = this.getDailyNotesPlugin();
    if (!daily) return null;
    if (daily.createDailyNote) {
      return daily.createDailyNote(typedMoment());
    }
    const format = this.getDateNotesFormat();
    const folder = daily.options?.folder ?? "";
    const name = `${typedMoment().format(format)}.md`;
    const path = folder ? `${folder}/${name}` : name;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    try {
      // Formats like "YYYY/MM/YYYY-MM-DD" put the note in subfolders that may not exist yet.
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
        await this.app.vault.createFolder(parent);
      }
      return await this.app.vault.create(path, "");
    } catch {
      return null;
    }
  }

  async runRollOverToToday(): Promise<void> {
    if (!this.settings.movePastTodosToToday) return;
    this.suppressRollOverOnCreate = true;
    try {
      const todayNote = await this.getOrCreateTodayNote();
      if (!todayNote) return;
      await this.migratePastTodosToToday(todayNote);
      this.refreshView();
    } finally {
      this.suppressRollOverOnCreate = false;
    }
  }

  private isDateNote(file: TFile, format: string): boolean {
    return parseDateNote(file, format).isValid();
  }

  // True only for notes whose filename is a valid date strictly after today.
  // Non-date notes return false so they are never hidden by this filter.
  private isFutureDateNote(file: TFile, format: string): boolean {
    const parsed = parseDateNote(file, format);
    return parsed.isValid() && parsed.isAfter(typedMoment(), "day");
  }

  private isTodayDateNote(file: TFile): boolean {
    const format = this.getDateNotesFormat();
    const parsed = parseDateNote(file, format);
    return parsed.isValid() && parsed.isSame(typedMoment(), "day");
  }

  private getEditorForFile(file: TFile): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === file.path) return view.editor;
    }
    return null;
  }

  private pushUndo(fn: UndoFn): void {
    this.undoStack.push(fn);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  // Reverts the most recent panel action (check off, delete, move), across
  // notes. Entries that no longer apply (e.g. the todo was already unchecked
  // by hand) are skipped, so each press undoes something.
  async undoLastSidebarAction(): Promise<void> {
    await this.enqueue(async () => {
      let fn: UndoFn | undefined;
      while ((fn = this.undoStack.pop())) {
        if (await fn()) break;
      }
    });
    this.refreshView();
  }

  // Edits a note's lines in place. `edit` mutates the array and returns
  // whether it changed anything. In an open editor only the changed span is
  // replaced, so the cursor and editor history stay intact.
  private async editLines(file: TFile, edit: (lines: string[]) => boolean): Promise<boolean> {
    const editor = this.getEditorForFile(file);
    const before = editor ? editor.getValue() : await this.app.vault.read(file);
    const lines = before.split("\n");
    if (!edit(lines)) return false;
    const after = lines.join("\n");
    if (after === before) return false;
    if (editor) {
      let start = 0;
      while (start < before.length && start < after.length && before[start] === after[start]) start++;
      let end = 0;
      while (end < before.length - start && end < after.length - start &&
        before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
      editor.replaceRange(
        after.slice(start, after.length - end),
        editor.offsetToPos(start),
        editor.offsetToPos(before.length - end),
      );
    } else {
      await this.app.vault.modify(file, after);
    }
    this.syncContent(file, after);
    return true;
  }

  private findTodoLine(lines: string[], todo: TodoItem): number {
    // Prefer matches near the cached line index — this disambiguates when the
    // file has multiple identical todo lines. Fall back to a full-file search
    // when the line has shifted further than the ±2 window. A done todo is
    // looked up among the checked-off lines.
    const prefix = todo.done ? TODO_DONE_PREFIX : TODO_OPEN_PREFIX;
    const near = lines.findIndex((l, i) =>
      i >= todo.lineIndex - 2 && i <= todo.lineIndex + 2 &&
      prefix.test(l) && l.includes(todo.text)
    );
    if (near >= 0) return near;
    return lines.findIndex(l => prefix.test(l) && l.includes(todo.text));
  }

  async deleteTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      let idx = -1;
      let deletedLine = "";
      const deleted = await this.editLines(todo.file, (lines) => {
        idx = this.findTodoLine(lines, todo);
        if (idx < 0 || !TODO_OPEN_PREFIX.test(lines[idx])) return false;
        [deletedLine] = lines.splice(idx, 1);
        return true;
      });
      if (!deleted) return;
      this.pushUndo(() => this.editLines(todo.file, (lines) => {
        lines.splice(Math.min(idx, lines.length), 0, deletedLine);
        return true;
      }));
    });
  }

  async completeTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      let completed: Array<{ line: number; text: string }> = [];
      const changed = await this.editLines(todo.file, (lines) => {
        const idx = this.findTodoLine(lines, todo);
        if (idx < 0 || !TODO_OPEN_PREFIX.test(lines[idx])) return false;
        completed = this.linesToComplete(lines, idx).map((line) => {
          const text = lines[line].match(TODO_OPEN_RE)?.[1] ?? todo.text;
          lines[line] = lines[line].replace("- [ ]", "- [x]");
          return { line, text };
        });
        return true;
      });
      if (!changed) return;
      // Unchecks the todo and the nested todos checked off with it.
      this.pushUndo(() => this.editLines(todo.file, (lines) => {
        let reverted = false;
        for (const { line, text } of completed) {
          const i = this.findTodoLine(lines, { file: todo.file, text, lineIndex: line, done: true });
          if (i >= 0) {
            lines[i] = lines[i].replace("- [x]", "- [ ]");
            reverted = true;
          }
        }
        return reverted;
      }));
    });
  }

  // Unchecks a todo that is still shown as done in the panel, together with
  // the done todos nested under it that are still shown too (checked off along
  // with it). Cmd/Ctrl+Z undoes it in the editor.
  async reopenTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      const editor = this.getEditorForFile(todo.file);
      const lines = editor ? editor.getValue().split("\n") : (await this.app.vault.read(todo.file)).split("\n");
      const idx = this.findTodoLine(lines, { ...todo, done: true });
      if (idx < 0) return;
      const shown = this.recentlyDone.get(todo.file.path);
      const toReopen = [idx, ...collectDescendantLines(lines, idx).filter((i) => {
        const text = lines[i].match(TODO_DONE_RE)?.[1];
        return text !== undefined && shown?.has(text);
      })];
      if (editor) {
        editor.transaction({
          changes: toReopen.map((line) => {
            const ch = lines[line].indexOf("- [x]");
            return { from: { line, ch }, to: { line, ch: ch + 5 }, text: "- [ ]" };
          }),
        });
        this.syncContent(todo.file, editor.getValue());
      } else {
        for (const line of toReopen) lines[line] = lines[line].replace("- [x]", "- [ ]");
        await this.app.vault.modify(todo.file, lines.join("\n"));
        this.syncContent(todo.file, lines.join("\n"));
      }
    });
  }

  // The lines checked off when completing the todo at `idx`: the todo itself
  // and, if completeNestedTodos is on, the open todos nested under it.
  private linesToComplete(lines: string[], idx: number): number[] {
    if (!this.settings.completeNestedTodos) return [idx];
    return [idx, ...collectDescendantLines(lines, idx).filter((i) => TODO_OPEN_RE.test(lines[i]))];
  }

  // Where a todo dropped next to `anchor` goes: before the anchor's own line,
  // or (after) the line following its nested children, indented like the
  // anchor. Without an anchor, or if it can't be found, the end of the note
  // with the todo's indentation unchanged (indent null).
  private resolveDrop(lines: string[], anchor?: DropAnchor): { line: number; indent: string | null } {
    if (!anchor) return { line: lines.length, indent: null };
    const idx = this.findTodoLine(lines, anchor.todo);
    if (idx < 0) return { line: lines.length, indent: null };
    const line = anchor.after ? idx + 1 + collectDescendantLines(lines, idx).length : idx;
    return { line, indent: splitListIndent(lines[idx]).indent };
  }

  async moveTodo(todo: TodoItem, targetFile: TFile, anchor?: DropAnchor): Promise<void> {
    return this.enqueue(async () => {
      if (todo.file.path === targetFile.path && anchor === undefined) return;

      if (todo.file.path === targetFile.path) {
        const content = await this.app.vault.read(todo.file);
        const lines = content.split("\n");
        const srcIdx = this.findTodoLine(lines, todo);
        if (srcIdx < 0) return;
        const drop = this.resolveDrop(lines, anchor);
        const insertBeforeLine = drop.line;
        // Move the todo together with its nested children (indented lines that
        // follow it), so dragging a parent keeps its sub-items attached.
        const blockLen = 1 + collectDescendantLines(lines, srcIdx).length;
        // Dropping onto the todo itself or one of its own children is a no-op.
        if (insertBeforeLine !== undefined && insertBeforeLine > srcIdx && insertBeforeLine < srcIdx + blockLen) return;
        const original = lines.slice(srcIdx, srcIdx + blockLen);
        const block = drop.indent === null ? original : reindentBlock(original, drop.indent);
        lines.splice(srcIdx, blockLen);
        let insertIdx = insertBeforeLine;
        if (srcIdx < insertIdx) insertIdx -= blockLen;
        // Same place and same indentation: nothing to do.
        if (insertIdx === srcIdx && block.every((l, i) => l === original[i])) return;
        lines.splice(insertIdx, 0, ...block);
        await this.app.vault.modify(todo.file, lines.join("\n"));
        this.pushUndo(() => this.editLines(todo.file, (cur) => {
          const at = this.findTodoLine(cur, { ...todo, lineIndex: insertIdx });
          if (at < 0) return false;
          cur.splice(at, blockLen);
          cur.splice(Math.min(srcIdx, cur.length), 0, ...original);
          return true;
        }));
      } else {
        const srcContent = await this.app.vault.read(todo.file);
        const srcLines = srcContent.split("\n");
        const srcIdx = this.findTodoLine(srcLines, todo);
        if (srcIdx < 0) return;
        // Carry the todo's nested children (following indented lines) along.
        const blockLen = 1 + collectDescendantLines(srcLines, srcIdx).length;
        const block = srcLines.slice(srcIdx, srcIdx + blockLen);
        srcLines.splice(srcIdx, blockLen);

        const tgtContent = await this.app.vault.read(targetFile);
        const tgtLines = tgtContent.split("\n");
        const drop = this.resolveDrop(tgtLines, anchor);
        tgtLines.splice(drop.line, 0, ...(drop.indent === null ? block : reindentBlock(block, drop.indent)));

        const srcPath = todo.file.path;
        await this.app.vault.modify(todo.file, srcLines.join("\n"));
        await this.app.vault.modify(targetFile, tgtLines.join("\n"));
        this.pushUndo(async () => {
          const removed = await this.editLines(targetFile, (cur) => {
            const at = this.findTodoLine(cur, { ...todo, lineIndex: drop.line });
            if (at < 0) return false;
            cur.splice(at, blockLen);
            return true;
          });
          if (!removed) return false;
          await this.editLines(todo.file, (cur) => {
            cur.splice(Math.min(srcIdx, cur.length), 0, ...block);
            return true;
          });
          return true;
        });
        const srcFile = this.app.vault.getAbstractFileByPath(srcPath);
        if (srcFile instanceof TFile) await this.updateIndex(srcFile);
      }
      await this.updateIndex(targetFile);
    });
  }

  async migratePastTodosToToday(todayNote: TFile): Promise<void> {
    if (!this.settings.movePastTodosToToday) return;

    const format = this.getDateNotesFormat();
    const today = typedMoment().startOf("day");
    if (!this.isTodayDateNote(todayNote)) return;

    const removals = new Map<string, number[]>();

    for (const [path, items] of this.index) {
      if (path === todayNote.path) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const noteDate = parseDateNote(file, format);
      if (!noteDate.isValid() || !noteDate.isBefore(today)) continue;

      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      for (const item of items) {
        if (item.done) continue;
        const idx = this.findTodoLine(lines, { file, lineIndex: item.lineIndex, text: item.text });
        if (idx >= 0) {
          if (!removals.has(path)) removals.set(path, []);
          removals.get(path)!.push(idx);
        }
      }
    }

    if (removals.size === 0) return;

    return this.enqueue(async () => {
      this.suppressRefresh = true;
      try {
        // Collect the lines to move and remove them from the source note in a
        // single fresh read, inside the write queue. This keeps move-and-remove
        // atomic: a todo is only appended to today's note if it was actually
        // removed from its source, so a stale index can never leave the old
        // todo behind (duplicated) instead of moving it over.
        const linesToMove: string[] = [];
        for (const [path, indices] of removals) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) continue;
          const content = await this.app.vault.read(file);
          const lines = content.split("\n");
          const validIndices = indices.filter(
            (idx) => lines[idx] && TODO_OPEN_PREFIX.test(lines[idx])
          );
          if (validIndices.length === 0) continue;
          linesToMove.push(...collectMigrationLines(lines, validIndices));
          // Remove the moved todos, plus the header of any callout that is left
          // empty once its todos are gone.
          const toRemove = new Set(validIndices);
          for (const idx of collectEmptyCalloutRemovals(lines, validIndices)) {
            toRemove.add(idx);
          }
          for (const idx of [...toRemove].sort((a, b) => b - a)) lines.splice(idx, 1);
          await this.app.vault.modify(file, lines.join("\n"));
          await this.updateIndex(file);
        }

        if (linesToMove.length === 0) return;

        const todayContent = await this.app.vault.read(todayNote);
        const todayLines = todayContent.length > 0 ? todayContent.split("\n") : [];
        todayLines.push(...linesToMove);
        await this.app.vault.modify(todayNote, todayLines.join("\n"));
        await this.updateIndex(todayNote);
      } finally {
        this.suppressRefresh = false;
        this.refreshView();
      }
    });
  }

  async toggleFold(key: string): Promise<void> {
    const i = this.settings.foldedKeys.indexOf(key);
    if (i >= 0) this.settings.foldedKeys.splice(i, 1);
    else this.settings.foldedKeys.push(key);
    await this.saveSettings();
  }

  async togglePin(path: string): Promise<void> {
    const i = this.settings.pinnedPaths.indexOf(path);
    if (i >= 0) this.settings.pinnedPaths.splice(i, 1);
    else this.settings.pinnedPaths.push(path);
    await this.saveSettings();
  }

  async navigateToFile(file: TFile): Promise<WorkspaceLeaf> {
    const leaf =
      this.app.workspace.getLeavesOfType("markdown").find(
        (l) => (l.view as MarkdownView).file?.path === file.path
      ) ??
      this.app.workspace.getLeavesOfType("markdown")[0] ??
      this.app.workspace.getLeaf(false);

    await leaf.openFile(file, { active: true });
    return leaf;
  }

  private revealLine(editor: Editor, line: number): void {
    const pos = { line, ch: editor.getLine(line).length };
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);
  }

  async navigateToLine(file: TFile, line: number): Promise<void> {
    const leaf = await this.navigateToFile(file);
    const editor: Editor = (leaf.view as MarkdownView).editor;
    this.revealLine(editor, Math.min(line, editor.lastLine()));
  }

  async navigateToTodo(todo: TodoItem): Promise<void> {
    const leaf = await this.navigateToFile(todo.file);
    const view = leaf.view as MarkdownView;
    const editor: Editor = view.editor;

    // The cached lineIndex may be stale if the file shifted since indexing.
    // Re-locate the line by matching the todo text on an open unchecked item.
    const lines = editor.getValue().split("\n");
    let lineIdx = lines.findIndex(
      (l) => (todo.done ? TODO_DONE_PREFIX : TODO_OPEN_PREFIX).test(l) && l.includes(todo.text)
    );
    if (lineIdx < 0) lineIdx = Math.min(todo.lineIndex, lines.length - 1);

    this.revealLine(editor, lineIdx);
  }

  refreshView(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ChecklistView) leaf.view.render();
    });
  }

  // Display-only change: re-render without resetting the note order.
  async setShowNoteTitles(value: boolean): Promise<void> {
    await this.updateSetting("showNoteTitles", value);
  }

  // Saves one setting changed in the settings tab (or the panel header) and
  // applies it: titles only need a re-render, roll-over runs once when turned
  // on, everything else changes sorting/filtering and rebuilds the views.
  async updateSetting<K extends EditableSettingKey>(key: K, value: ChecklistSettings[K]): Promise<void> {
    this.settings[key] = value;
    await this.saveSettings();
    if (key === "showNoteTitles" || key === "showHeadings" || key === "showCompleted") this.refreshView();
    else if (key === "movePastTodosToToday") {
      if (value) await this.runRollOverToToday();
    } else this.applySettingsToViews();
  }

  // Called by the settings tab after sort/filter changes so views drop their
  // stable display order and rebuild with the new settings applied.
  applySettingsToViews(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ChecklistView) leaf.view.applySettings();
    });
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}

// Description of the "Exclude todos" box: what each kind of line matches.
function excludeRulesHelp(): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText("Hide todos from the panel. One rule per line:");
    const list = frag.createEl("ul");
    list.createEl("li", { text: "define: todos containing this word (case-insensitive)" });
    list.createEl("li", { text: "Templates/: every note in this folder and its subfolders" });
    list.createEl("li", { text: "Projects/Games backlog.md: this note" });
    list.createEl("li", { text: "/weekly planner/: notes whose path matches this regular expression (case-insensitive)" });
  });
}

class ChecklistSettingTab extends PluginSettingTab {
  plugin: ChecklistPlugin;

  constructor(app: App, plugin: ChecklistPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Declarative settings (Obsidian 1.13+): rendered by Obsidian and indexed by
  // its settings search. display() renders the same definitions on older versions.
  getSettingDefinitions(): SettingDefinitionGroup<EditableSettingKey>[] {
    return [
      {
        type: "group",
        heading: "Display",
        items: [
          {
            name: "Note sort order",
            desc: "How note groups are ordered in the panel. Todos within each note keep their order in the file.",
            control: {
              type: "dropdown",
              key: "sortMode",
              options: {
                recent: "Recently modified note first",
                oldest: "Least recently modified note first",
                alpha: "Note name (A–Z)",
                "alpha-desc": "Note name (Z–A)",
              },
            },
          },
          {
            name: "Show note titles",
            desc: "Group todos under their note's title. Also toggled from the panel header.",
            control: { type: "toggle", key: "showNoteTitles" },
          },
          {
            name: "Show headings",
            desc: "Group todos under the nearest heading above them.",
            control: { type: "toggle", key: "showHeadings" },
          },
          {
            name: "Show completed todos",
            desc:
              "Keep todos checked off in this time span in the panel, greyed out below the open todos of their note or heading. " +
              "Completion times are recorded for the last 30 days, whatever this is set to. All also shows " +
              "todos checked off before that.",
            aliases: ["done", "checked", "history"],
            control: { type: "dropdown", key: "showCompleted", options: COMPLETED_OPTIONS },
          },
        ],
      },
      {
        type: "group",
        heading: "Filters",
        items: [
          {
            name: "Todo scope",
            desc: "Which todos to show. Note and folder scopes follow the active note.",
            control: { type: "dropdown", key: "todoScope", options: SCOPE_OPTIONS },
          },
          {
            name: "Date notes only",
            desc: "Show todos only from notes whose filename matches your Daily Notes date format.",
            control: { type: "toggle", key: "dateNotesOnly" },
          },
          {
            name: "Hide future date notes",
            desc: "Hide todos from date notes whose filename is a date after today, so planning-ahead notes stay out of the panel.",
            control: { type: "toggle", key: "hideFutureDateNotes" },
          },
          {
            name: "Exclude todos",
            desc: excludeRulesHelp(),
            aliases: ["keyword", "folder", "regex", "ignore"],
            control: {
              type: "textarea",
              key: "excludeRules",
              placeholder: "define\nTemplates/\nProjects/Games backlog.md\n/weekly planner/",
              rows: 6,
              validate: (value) => {
                const { invalid } = parseExcludeRules(value);
                if (invalid.length > 0) return `Invalid regular expression: ${invalid.join(", ")}`;
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Checking off",
        items: [
          {
            name: "Check off nested todos",
            desc: "When you check off a todo in the panel, also check off the open todos indented beneath it.",
            control: { type: "toggle", key: "completeNestedTodos" },
          },
        ],
      },
      {
        type: "group",
        heading: "Daily notes",
        items: [
          {
            name: "Roll over open todos",
            desc:
              "When today's daily note is created (e.g. via the Daily Notes shortcut), or when this " +
              "setting is turned on, move open todos from past daily notes into it. Callout headers " +
              "are copied with todos inside callouts. Past notes are detected using your Daily Notes date format.",
            control: { type: "toggle", key: "movePastTodosToToday" },
          },
        ],
      },
    ];
  }

  setControlValue(key: string, value: unknown): Promise<void> {
    return this.plugin.updateSetting(key as EditableSettingKey, value as never);
  }

  // Fallback for Obsidian < 1.13, which doesn't render getSettingDefinitions().
  // Not called on 1.13+ because the definitions above are non-empty.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const group of this.getSettingDefinitions()) {
      if (group.heading) new Setting(containerEl).setName(group.heading).setHeading();
      for (const item of group.items ?? []) {
        if (!("control" in item) || !item.control) continue;
        const setting = new Setting(containerEl).setName(item.name);
        if (item.desc) setting.setDesc(item.desc);
        this.addControl(setting, item.control);
      }
    }
  }

  private addControl(setting: Setting, control: SettingControl<EditableSettingKey>): void {
    const settings = this.plugin.settings;
    switch (control.type) {
      case "toggle": {
        const key = control.key as BooleanSettingKey;
        setting.addToggle((toggle) =>
          toggle.setValue(settings[key]).onChange((value) => this.plugin.updateSetting(key, value))
        );
        break;
      }
      case "dropdown": {
        const { options } = control;
        const key = control.key as "sortMode" | "todoScope" | "showCompleted";
        setting.addDropdown((dropdown) =>
          dropdown
            .addOptions(options)
            .setValue(settings[key])
            .onChange((value) => this.plugin.updateSetting(key, value as SortMode & TodoScope & CompletedRange))
        );
        break;
      }
      case "textarea": {
        const { placeholder, rows, validate } = control;
        const key = control.key as "excludeRules";
        // Mirrors the declarative API: show the validation message and only
        // persist values that pass.
        const errorEl = setting.descEl.createDiv({ cls: "mod-warning" });
        const check = async (value: string): Promise<boolean> => {
          const error = (await validate?.(value)) || "";
          errorEl.setText(error);
          return !error;
        };
        setting.addTextArea((text) => {
          text
            .setPlaceholder(placeholder ?? "")
            .setValue(settings[key])
            .onChange(async (value) => {
              if (await check(value)) await this.plugin.updateSetting(key, value);
            });
          if (rows) text.inputEl.rows = rows;
        });
        void check(settings[key]);
        break;
      }
    }
  }
}
