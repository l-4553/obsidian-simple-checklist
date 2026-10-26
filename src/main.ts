import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  moment,
  Plugin,
  PluginSettingTab,
  Setting,
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

interface TodoItem {
  file: TFile;
  lineIndex: number;
  text: string;
  // Nesting level mirrored from the source note (0 = top level). Optional so that
  // transient TodoItems built outside getAllTodos default to unindented.
  depth?: number;
}

type SortMode = "recent" | "oldest" | "alpha" | "alpha-desc";

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
  sortMode: SortMode;
  dateNotesOnly: boolean;
  hideFutureDateNotes: boolean;
  movePastTodosToToday: boolean;
  // Exclude rules, one per line: keyword, "Folder/", "Note.md" or "/regex/".
  excludeRules: string;
  // Note paths pinned to the top of the panel, in pin order (most-recent last).
  pinnedPaths: string[];
}

const DEFAULT_SETTINGS: ChecklistSettings = {
  sortMode: "recent",
  dateNotesOnly: false,
  hideFutureDateNotes: false,
  movePastTodosToToday: false,
  excludeRules: "",
  pinnedPaths: [],
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
// parent are ordered by trailing "!" (more first, ties keep written order), and
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
    // Sort siblings by trailing "!" (descending), keeping written order on ties.
    const sorted = groups
      .map((g, idx) => ({ g, idx }))
      .sort((a, b) => {
        const d = trailingBangs(b.g.item.text) - trailingBangs(a.g.item.text);
        return d !== 0 ? d : a.idx - b.idx;
      });
    const out: TodoItem[] = [];
    for (const { g } of sorted) out.push(g.item, ...g.children);
    return out;
  };
  return order(0, items.length);
}

// Todo lines, with optional callout prefix(es): "  > > - [ ] text" matches.
// TODO_OPEN_RE captures the trailing text; the *_PREFIX variants are tests only.
const TODO_OPEN_RE = /^\s*(?:>\s*)*-\s\[ \]\s(.+)/;
const TODO_OPEN_PREFIX = /^\s*(?:>\s*)*-\s\[ \]/;
const TODO_DONE_PREFIX = /^\s*(?:>\s*)*-\s\[x\]/;
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
// the "[label](" start of markdown links, bare http(s) URLs, and inline code `code`.
// Markdown link labels may contain one level of nested brackets; the link target
// is found by findLinkTargetEnd so parentheses inside URLs are counted.
// Bare URLs may contain balanced parentheses ("…/Foo_(bar)") but don't swallow
// a closing ")" around them ("(see https://x.y)").
const LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]|\[((?:[^[\]]|\[[^[\]]*\])+)\]\(|(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+)|`([^`]+)`/g;

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

function renderTodoText(
  container: HTMLElement,
  text: string,
  sourcePath: string,
  openLink: (target: string, subpath: string, source: string) => void
): void {
  let last = 0;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) container.appendText(text.slice(last, m.index));
    let end = m.index + m[0].length;
    if (m[1] !== undefined) {
      const target = m[1].trim();
      const heading = m[2]?.trim() ?? "";
      const label = m[3]?.trim() || (heading ? `${target} > ${heading}` : target);
      const subpath = heading ? `#${heading}` : "";
      const link = container.createEl("a", { cls: "checklist-inline-link", text: label });
      link.addEventListener("click", (e) => { e.stopPropagation(); openLink(target, subpath, sourcePath); });
    } else if (m[4] !== undefined) {
      const close = findLinkTargetEnd(text, end);
      if (close === -1 || close === end) {
        // Unclosed or empty "[label](": keep the "[" as text and rescan right after it,
        // so links and URLs in the rest of the text are still rendered.
        container.appendText("[");
        last = m.index + 1;
        LINK_RE.lastIndex = last;
        continue;
      }
      const label = m[4];
      const target = text.slice(end, close).replace(/\\([()])/g, "$1");
      end = close + 1;
      LINK_RE.lastIndex = end;
      if (isExternalUrl(target)) {
        createExternalLink(container, label, target);
      } else {
        const link = container.createEl("a", { cls: "checklist-inline-link", text: label });
        link.addEventListener("click", (e) => { e.stopPropagation(); openLink(target, "", sourcePath); });
      }
    } else if (m[5] !== undefined) {
      const url = m[5];
      createExternalLink(container, url, url);
    } else {
      container.createEl("code", { cls: "checklist-inline-code", text: m[6] });
    }
    last = end;
  }
  if (last < text.length) container.appendText(text.slice(last));
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
    const el = doc.createElement("div");
    el.className = "checklist-confetti-particle";
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
    doc.body.appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }
}

// Stable key for a todo: uses text content so it survives line-number shifts.
// Appends a counter to handle duplicate text within the same file.
function itemKey(filePath: string, text: string, occurrence: number): string {
  return occurrence === 0 ? `${filePath}\0${text}` : `${filePath}\0${text}\0${occurrence}`;
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

  // Called by the plugin when settings change — resets the stable order so
  // the new sort/filter takes effect on the next render.
  applySettings(): void {
    this.displayOrder = [];
    this.render();
  }

  constructor(leaf: WorkspaceLeaf, plugin: ChecklistPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Checklist"; }
  getIcon(): string { return "check-square"; }
  onOpen(): Promise<void> {
    this.render();
    // Forward Cmd/Ctrl+Z to the last-modified editor, or our own undo stack if file isn't open
    this.containerEl.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key !== "z") return;
      const editor = this.plugin.getLastModifiedEditor();
      if (editor) {
        e.preventDefault();
        editor.undo();
      } else {
        e.preventDefault();
        void this.plugin.undoLastSidebarAction();
      }
    });
    return Promise.resolve();
  }
  onClose(): Promise<void> { return Promise.resolve(); }

  triggerExternalCompletion(filePath: string, completedTexts: Set<string>): void {
    for (const [key, row] of this.rowEls) {
      const parts = key.split("\0");
      if (parts[0] === filePath && completedTexts.has(parts[1])) {
        const checkbox = row.querySelector<HTMLElement>(".checklist-checkbox");
        if (checkbox) spawnConfetti(checkbox);
        const groupEl = row.parentElement;
        row.remove();
        this.rowEls.delete(key);
        if (groupEl && !groupEl.querySelector(".checklist-item")) {
          groupEl.remove();
          this.groupEls.delete(filePath);
        }
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
      const base = `${t.file.path}\0${t.text}`;
      const occ = occurrences.get(base) ?? 0;
      occurrences.set(base, occ + 1);
      return itemKey(t.file.path, t.text, occ);
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
    this.wrapper.querySelectorAll(".checklist-divider").forEach(d => d.remove());

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
      this.wrapper.appendChild(groupData.group);

      // Reconcile items using text-based keys
      const fileOccurrences = new Map<string, number>();
      for (const todo of items) {
        const base = `${filePath}\0${todo.text}`;
        const occ = fileOccurrences.get(base) ?? 0;
        fileOccurrences.set(base, occ + 1);
        const key = itemKey(filePath, todo.text, occ);

        let row = this.rowEls.get(key);
        if (!row) {
          row = this.buildRow(todo, groupData.group, key, occ);
          this.rowEls.set(key, row);
        }
        // Set on every reconcile so re-indenting a todo in the note updates the row.
        row.style.setProperty("--checklist-depth", String(todo.depth ?? 0));
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
    const rows = Array.from(groupEl.querySelectorAll<HTMLElement>(":scope > .checklist-item"));
    if (rows.length === 0) return null;
    const node = e.targetNode;
    const over = node?.instanceOf(HTMLElement) ? node.closest<HTMLElement>(".checklist-item") : null;
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

  private buildRow(todo: TodoItem, groupEl: HTMLElement, key: string, occurrence: number): HTMLElement {
    const row = createDiv({ cls: "checklist-item" });

    const checkbox = row.createDiv({ cls: "checklist-checkbox" });
    let completing = false;
    checkbox.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      if (completing) return;
      completing = true;
      spawnConfetti(checkbox);
      this.plugin.suppressRefresh = true;
      void this.plugin.completeTodo(todo).then(() => {
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

    const text = row.createDiv({ cls: "checklist-text" });
    renderTodoText(text, todo.text, todo.file.path, (target, subpath, source) => {
      void this.plugin.app.workspace.openLinkText(target + subpath, source, false);
    });
    text.addEventListener("click", (e: MouseEvent) => {
      const target = e.targetNode;
      if (!target?.instanceOf(HTMLElement) || !target.classList.contains("checklist-inline-link")) {
        void this.plugin.navigateToTodo(todo);
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
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("checklist-item-dragging");
      this.showDropIndicator(null);
    });

    return row;
  }
}

export default class ChecklistPlugin extends Plugin {
  private index: Map<string, Array<{ lineIndex: number; text: string; indent: number }>> = new Map();
  suppressRefresh = false;
  settings: ChecklistSettings = { ...DEFAULT_SETTINGS };
  private writeQueue: Promise<void> = Promise.resolve();
  // Tracks the last content we processed per file so editor-change and vault-modify don't double-fire
  private lastProcessedContent = new Map<string, string>();
  private lastModifiedFile: TFile | null = null;
  private undoStack: Array<() => Promise<void>> = [];
  private suppressRollOverOnCreate = false;

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn);
    return this.writeQueue;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as (Partial<ChecklistSettings> & { excludeKeywords?: string }) | null;
    const { excludeKeywords, ...rest } = stored ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...rest };
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
    this.registerView(VIEW_TYPE, (leaf) => new ChecklistView(leaf, this));
    this.addRibbonIcon("check-square", "Open Checklist", () => { void this.activateView(); });
    this.addCommand({ id: "open-checklist", name: "Open Checklist panel", callback: () => { void this.activateView(); } });
    this.addSettingTab(new ChecklistSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      await this.buildIndex();
      this.refreshView();
    });

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
      if (file instanceof TFile) { this.index.delete(file.path); this.refreshView(); }
    }));

    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") {
        this.index.delete(oldPath);
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
    const todos: Array<{ lineIndex: number; text: string; indent: number }> = [];
    content.split("\n").forEach((line, i) => {
      const m = line.match(TODO_OPEN_RE);
      if (m) todos.push({ lineIndex: i, text: m[1], indent: listIndentWidth(line) });
    });
    if (todos.length > 0) this.index.set(filePath, todos);
    else this.index.delete(filePath);
  }

  private handleContentChange(file: TFile, content: string): void {
    const oldTodos = this.index.get(file.path) ?? [];
    this.lastProcessedContent.set(file.path, content);
    this.indexContent(file.path, content);
    const newTexts = new Set((this.index.get(file.path) ?? []).map(t => t.text));

    const completedTexts = new Set<string>();
    if (oldTodos.length > 0) {
      const lines = content.split("\n");
      for (const old of oldTodos) {
        if (!newTexts.has(old.text)) {
          const lo = Math.max(0, old.lineIndex - 2);
          const hi = Math.min(lines.length - 1, old.lineIndex + 2);
          for (let i = lo; i <= hi; i++) {
            if (TODO_DONE_PREFIX.test(lines[i]) && lines[i].includes(old.text)) {
              completedTexts.add(old.text);
              break;
            }
          }
        }
      }
    }

    if (completedTexts.size > 0) {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
        if (leaf.view instanceof ChecklistView) leaf.view.triggerExternalCompletion(file.path, completedTexts);
      });
    }

    if (!this.suppressRefresh) this.refreshView();
  }

  getAllTodos(): TodoItem[] {
    const todos: TodoItem[] = [];
    // Resolve the date format once if any date-based filter is active.
    const needsFormat = this.settings.dateNotesOnly || this.settings.hideFutureDateNotes;
    const format = needsFormat ? this.getDateNotesFormat() : null;
    const exclude = parseExcludeRules(this.settings.excludeRules);
    for (const [path, items] of this.index) {
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
        noteTodos.push({ file, lineIndex: item.lineIndex, text: item.text, depth });
      }
      // Priority-sort within the note, per indentation level, keeping each
      // item's nested children with it. The view groups by note path and
      // orders the note groups itself, so todos only need to be contiguous and
      // correctly ordered within their own note here.
      todos.push(...sortTodosByPriority(noteTodos));
    }
    return todos;
  }

  getEmptyMessage(): string {
    const hasFilters =
      this.settings.dateNotesOnly ||
      this.settings.hideFutureDateNotes ||
      hasExcludeRules(parseExcludeRules(this.settings.excludeRules));
    return hasFilters ? "No open todos match the current filters." : "No open todos.";
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
    return typedMoment(file.basename, format, true).isValid();
  }

  // True only for notes whose filename is a valid date strictly after today.
  // Non-date notes return false so they are never hidden by this filter.
  private isFutureDateNote(file: TFile, format: string): boolean {
    const parsed = typedMoment(file.basename, format, true);
    return parsed.isValid() && parsed.isAfter(typedMoment(), "day");
  }

  private isTodayDateNote(file: TFile): boolean {
    const format = this.getDateNotesFormat();
    const parsed = typedMoment(file.basename, format, true);
    return parsed.isValid() && parsed.isSame(typedMoment(), "day");
  }

  private getEditorForFile(file: TFile): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === file.path) return view.editor;
    }
    return null;
  }

  getLastModifiedEditor(): Editor | null {
    return this.lastModifiedFile ? this.getEditorForFile(this.lastModifiedFile) : null;
  }

  async undoLastSidebarAction(): Promise<void> {
    const fn = this.undoStack.pop();
    if (fn) await fn();
  }

  private findTodoLine(lines: string[], todo: TodoItem): number {
    // Prefer matches near the cached line index — this disambiguates when the
    // file has multiple identical todo lines. Fall back to a full-file search
    // when the line has shifted further than the ±2 window.
    const near = lines.findIndex((l, i) =>
      i >= todo.lineIndex - 2 && i <= todo.lineIndex + 2 &&
      TODO_OPEN_PREFIX.test(l) && l.includes(todo.text)
    );
    if (near >= 0) return near;
    return lines.findIndex(l => TODO_OPEN_PREFIX.test(l) && l.includes(todo.text));
  }

  async deleteTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      const editor = this.getEditorForFile(todo.file);
      if (editor) {
        const lines = editor.getValue().split("\n");
        const idx = this.findTodoLine(lines, todo);
        if (idx >= 0 && lines[idx] && TODO_OPEN_PREFIX.test(lines[idx])) {
          const from = { line: idx, ch: 0 };
          // Delete the line including its newline; if it's the last line, delete the preceding newline
          const isLast = idx === lines.length - 1;
          const to = isLast
            ? { line: idx - 1, ch: lines[idx - 1]?.length ?? 0 }
            : { line: idx + 1, ch: 0 };
          if (isLast && idx === 0) {
            editor.replaceRange("", from, { line: idx, ch: lines[idx].length });
          } else if (isLast) {
            editor.replaceRange("", to, { line: idx, ch: lines[idx].length });
          } else {
            editor.replaceRange("", from, to);
          }
          this.lastModifiedFile = todo.file;
        }
      } else {
        const content = await this.app.vault.read(todo.file);
        const lines = content.split("\n");
        const idx = this.findTodoLine(lines, todo);
        if (idx >= 0 && lines[idx] && TODO_OPEN_PREFIX.test(lines[idx])) {
          const deletedLine = lines[idx];
          lines.splice(idx, 1);
          await this.app.vault.modify(todo.file, lines.join("\n"));
          this.lastModifiedFile = todo.file;
          this.undoStack.push(async () => {
            const current = await this.app.vault.read(todo.file);
            const cur = current.split("\n");
            cur.splice(idx, 0, deletedLine);
            await this.app.vault.modify(todo.file, cur.join("\n"));
          });
        }
      }
    });
  }

  async completeTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      const editor = this.getEditorForFile(todo.file);
      if (editor) {
        const lines = editor.getValue().split("\n");
        const idx = this.findTodoLine(lines, todo);
        if (idx >= 0 && lines[idx] && TODO_OPEN_PREFIX.test(lines[idx])) {
          const line = lines[idx];
          const col = line.indexOf("- [ ]");
          editor.replaceRange("- [x]", { line: idx, ch: col }, { line: idx, ch: col + 5 });
          this.lastModifiedFile = todo.file;
        }
      } else {
        const content = await this.app.vault.read(todo.file);
        const lines = content.split("\n");
        const idx = this.findTodoLine(lines, todo);
        if (idx >= 0 && lines[idx] && TODO_OPEN_PREFIX.test(lines[idx])) {
          const originalLine = lines[idx];
          lines[idx] = originalLine.replace("- [ ]", "- [x]");
          await this.app.vault.modify(todo.file, lines.join("\n"));
          this.lastModifiedFile = todo.file;
          this.undoStack.push(async () => {
            const current = await this.app.vault.read(todo.file);
            const cur = current.split("\n");
            const i = cur.findIndex((l, li) =>
              li >= idx - 2 && li <= idx + 2 && l.includes("- [x]") && l.includes(todo.text)
            );
            if (i >= 0) {
              cur[i] = cur[i].replace("- [x]", "- [ ]");
              await this.app.vault.modify(todo.file, cur.join("\n"));
            }
          });
        }
      }
    });
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
        this.lastModifiedFile = todo.file;
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
        this.lastModifiedFile = targetFile;
        this.undoStack.push(async () => {
          const curTgt = (await this.app.vault.read(targetFile)).split("\n");
          const tgtIdx = curTgt.findIndex((l) => TODO_OPEN_PREFIX.test(l) && l.includes(todo.text));
          if (tgtIdx < 0) return;
          curTgt.splice(tgtIdx, blockLen);
          await this.app.vault.modify(targetFile, curTgt.join("\n"));
          const curSrc = (await this.app.vault.read(todo.file)).split("\n");
          curSrc.splice(srcIdx, 0, ...block);
          await this.app.vault.modify(todo.file, curSrc.join("\n"));
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
      const noteDate = typedMoment(file.basename, format, true);
      if (!noteDate.isValid() || !noteDate.isBefore(today)) continue;

      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      for (const item of items) {
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
        this.lastModifiedFile = todayNote;
      } finally {
        this.suppressRefresh = false;
        this.refreshView();
      }
    });
  }

  async togglePin(path: string): Promise<void> {
    const i = this.settings.pinnedPaths.indexOf(path);
    if (i >= 0) this.settings.pinnedPaths.splice(i, 1);
    else this.settings.pinnedPaths.push(path);
    await this.saveSettings();
  }

  async navigateToFile(file: TFile): Promise<void> {
    const leaf =
      this.app.workspace.getLeavesOfType("markdown").find(
        (l) => (l.view as MarkdownView).file?.path === file.path
      ) ??
      this.app.workspace.getLeavesOfType("markdown")[0] ??
      this.app.workspace.getLeaf(false);

    await leaf.openFile(file, { active: true });
  }

  async navigateToTodo(todo: TodoItem): Promise<void> {
    const leaf =
      this.app.workspace.getLeavesOfType("markdown").find(
        (l) => (l.view as MarkdownView).file?.path === todo.file.path
      ) ??
      this.app.workspace.getLeavesOfType("markdown")[0] ??
      this.app.workspace.getLeaf(false);

    await leaf.openFile(todo.file, { active: true });

    const view = leaf.view as MarkdownView;
    const editor: Editor = view.editor;

    // The cached lineIndex may be stale if the file shifted since indexing.
    // Re-locate the line by matching the todo text on an open unchecked item.
    const lines = editor.getValue().split("\n");
    let lineIdx = lines.findIndex(
      (l) => TODO_OPEN_PREFIX.test(l) && l.includes(todo.text)
    );
    if (lineIdx < 0) lineIdx = Math.min(todo.lineIndex, lines.length - 1);

    const lineLength = editor.getLine(lineIdx).length;
    const pos = { line: lineIdx, ch: lineLength };
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);
  }

  refreshView(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ChecklistView) leaf.view.render();
    });
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

class ChecklistSettingTab extends PluginSettingTab {
  plugin: ChecklistPlugin;

  constructor(app: App, plugin: ChecklistPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Note sort order")
      .setDesc(
        "How note groups are ordered in the panel. Todos within each note keep their order in the file."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("recent", "Recently modified note first")
          .addOption("oldest", "Least recently modified note first")
          .addOption("alpha", "Note name (A–Z)")
          .addOption("alpha-desc", "Note name (Z–A)")
          .setValue(this.plugin.settings.sortMode)
          .onChange(async (value) => {
            this.plugin.settings.sortMode = value as SortMode;
            await this.plugin.saveSettings();
            this.plugin.applySettingsToViews();
          })
      );

    new Setting(containerEl)
      .setName("Date notes only")
      .setDesc("Show todos only from notes whose filename matches your Daily Notes date format.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dateNotesOnly).onChange(async (value) => {
          this.plugin.settings.dateNotesOnly = value;
          await this.plugin.saveSettings();
          this.plugin.applySettingsToViews();
        })
      );

    new Setting(containerEl)
      .setName("Hide future date notes")
      .setDesc("Hide todos from date notes whose filename is a date after today, so planning-ahead notes stay out of the panel.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideFutureDateNotes).onChange(async (value) => {
          this.plugin.settings.hideFutureDateNotes = value;
          await this.plugin.saveSettings();
          this.plugin.applySettingsToViews();
        })
      );

    new Setting(containerEl)
      .setName("Roll over open todos")
      .setDesc(
        "When today's daily note is created (e.g. via the Daily Notes shortcut), or when this " +
          "setting is turned on, move open todos from past daily notes into it. Callout headers " +
          "are copied with todos inside callouts. Past notes are detected using your Daily Notes date format."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.movePastTodosToToday).onChange(async (value) => {
          this.plugin.settings.movePastTodosToToday = value;
          await this.plugin.saveSettings();
          if (value) await this.plugin.runRollOverToToday();
        })
      );

    // ── Exclude todos: one rule per line, its shape decides what it matches ──
    const excludeSetting = new Setting(containerEl)
      .setName("Exclude todos")
      .addTextArea((text) => {
        text
          .setPlaceholder("define\nTemplates/\nProjects/Games backlog.md\n/weekly planner/")
          .setValue(this.plugin.settings.excludeRules)
          .onChange(async (value) => {
            this.plugin.settings.excludeRules = value;
            showExcludeHelp(value);
            await this.plugin.saveSettings();
            this.plugin.applySettingsToViews();
          });
        text.inputEl.rows = 6;
      });
    const showExcludeHelp = (raw: string): void => {
      const { descEl } = excludeSetting;
      descEl.empty();
      descEl.appendText("Hide todos from the panel. One rule per line:");
      const list = descEl.createEl("ul");
      list.createEl("li", { text: "define: todos containing this word (case-insensitive)" });
      list.createEl("li", { text: "Templates/: every note in this folder and its subfolders" });
      list.createEl("li", { text: "Projects/Games backlog.md: this note" });
      list.createEl("li", { text: "/weekly planner/: notes whose path matches this regular expression (case-insensitive)" });
      const { invalid } = parseExcludeRules(raw);
      if (invalid.length > 0) {
        descEl.createDiv({ cls: "mod-warning", text: `Invalid regular expression, ignored: ${invalid.join(", ")}` });
      }
    };
    showExcludeHelp(this.plugin.settings.excludeRules);
  }
}
