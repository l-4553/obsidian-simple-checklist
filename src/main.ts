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

const VIEW_TYPE = "checklist";

interface TodoItem {
  file: TFile;
  lineIndex: number;
  text: string;
}

type SortMode = "recent" | "alpha";

interface ChecklistSettings {
  sortMode: SortMode;
  dateNotesOnly: boolean;
}

const DEFAULT_SETTINGS: ChecklistSettings = {
  sortMode: "recent",
  dateNotesOnly: false,
};

// Minimal shape of the Daily Notes core plugin we touch. The internalPlugins
// container isn't in Obsidian's public type definitions, so we declare just
// enough to safely read the format setting.
interface DailyNotesPluginInstance {
  options?: { format?: string };
}
interface InternalPluginContainer {
  getPluginById(id: "daily-notes"): { instance?: DailyNotesPluginInstance } | null;
}
interface AppWithInternalPlugins {
  internalPlugins?: InternalPluginContainer;
}

// Matches [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]]
// and markdown links [label](target)
const LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]|\[([^\]]+)\]\(([^)]+)\)/g;

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
    if (m[1] !== undefined) {
      const target = m[1].trim();
      const heading = m[2]?.trim() ?? "";
      const label = m[3]?.trim() || (heading ? `${target} > ${heading}` : target);
      const subpath = heading ? `#${heading}` : "";
      const link = container.createEl("a", { cls: "checklist-inline-link", text: label });
      link.addEventListener("click", (e) => { e.stopPropagation(); openLink(target, subpath, sourcePath); });
    } else {
      const link = container.createEl("a", { cls: "checklist-inline-link", text: m[4] });
      link.addEventListener("click", (e) => { e.stopPropagation(); openLink(m![5], "", sourcePath); });
    }
    last = m.index + m[0].length;
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
  async onOpen(): Promise<void> {
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
  }
  async onClose(): Promise<void> {}

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
      const emptyText = this.plugin.settings.dateNotesOnly
        ? "No open todos in date notes."
        : "No open todos.";
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

    // ── Determine display order based on sort mode ───────────────────────────
    if (this.plugin.settings.sortMode === "alpha") {
      // Strictly alphabetical by file basename, recomputed each render.
      this.displayOrder = [...grouped.keys()].sort((a, b) => {
        const fa = grouped.get(a)![0].file;
        const fb = grouped.get(b)![0].file;
        return fa.basename.localeCompare(fb.basename);
      });
    } else {
      // Recent: stable order — keep existing positions, prepend new files
      // sorted by mtime (newest first). Prevents the list from jumping when
      // a file's mtime updates from completing a todo.
      this.displayOrder = this.displayOrder.filter(p => grouped.has(p));
      const newPaths = [...grouped.keys()]
        .filter(p => !this.displayOrder.includes(p))
        .sort((a, b) => {
          const fa = grouped.get(a)![0].file;
          const fb = grouped.get(b)![0].file;
          return fb.stat.mtime - fa.stat.mtime;
        });
      this.displayOrder = [...newPaths, ...this.displayOrder];
    }
    const orderedPaths = this.displayOrder;

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
        const title = group.createDiv({ cls: "checklist-group-title", text: items[0].file.basename });
        groupData = { group, title };
        this.groupEls.set(filePath, groupData);
      } else {
        groupData.title.setText(items[0].file.basename);
      }

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
          row = this.buildRow(todo, groupData.group, key);
          this.rowEls.set(key, row);
        }
        groupData.group.appendChild(row);
      }
    }
  }

  private buildRow(todo: TodoItem, groupEl: HTMLElement, key: string): HTMLElement {
    const row = createDiv({ cls: "checklist-item" });

    const checkbox = row.createDiv({ cls: "checklist-checkbox" });
    let completing = false;
    checkbox.addEventListener("click", (e) => {
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
    text.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).classList.contains("checklist-inline-link")) {
        void this.plugin.navigateToTodo(todo);
      }
    });

    const trash = row.createDiv({ cls: "checklist-trash" });
    setIcon(trash, "trash");
    let deleting = false;
    trash.addEventListener("click", (e) => {
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

    return row;
  }
}

export default class ChecklistPlugin extends Plugin {
  private index: Map<string, Array<{ lineIndex: number; text: string }>> = new Map();
  suppressRefresh = false;
  settings: ChecklistSettings = { ...DEFAULT_SETTINGS };
  private writeQueue: Promise<void> = Promise.resolve();
  // Tracks the last content we processed per file so editor-change and vault-modify don't double-fire
  private lastProcessedContent = new Map<string, string>();
  private lastModifiedFile: TFile | null = null;
  private undoStack: Array<() => Promise<void>> = [];

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn);
    return this.writeQueue;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<ChecklistSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
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
    const todos: Array<{ lineIndex: number; text: string }> = [];
    content.split("\n").forEach((line, i) => {
      const m = line.match(/^(\s*)-\s\[ \]\s(.+)/);
      if (m) todos.push({ lineIndex: i, text: m[2] });
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
            if (lines[i].match(/^(\s*)-\s\[x\]/) && lines[i].includes(old.text)) {
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
    const dateFilter = this.settings.dateNotesOnly ? this.getDateNotesFormat() : null;
    for (const [path, items] of this.index) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      if (dateFilter !== null && !this.isDateNote(file, dateFilter)) continue;
      for (const item of items) todos.push({ file, lineIndex: item.lineIndex, text: item.text });
    }
    if (this.settings.sortMode === "alpha") {
      todos.sort((a, b) => {
        const c = a.file.basename.localeCompare(b.file.basename);
        return c !== 0 ? c : a.lineIndex - b.lineIndex;
      });
    } else {
      todos.sort((a, b) => {
        const d = b.file.stat.mtime - a.file.stat.mtime;
        return d !== 0 ? d : a.lineIndex - b.lineIndex;
      });
    }
    return todos;
  }

  // Reads the Daily Notes core plugin's date format, falling back to the
  // Obsidian default. Returning a string keeps the call site simple.
  private getDateNotesFormat(): string {
    const container = (this.app as unknown as AppWithInternalPlugins).internalPlugins;
    const fmt = container?.getPluginById("daily-notes")?.instance?.options?.format;
    return typeof fmt === "string" && fmt.length > 0 ? fmt : "YYYY-MM-DD";
  }

  private isDateNote(file: TFile, format: string): boolean {
    return moment(file.basename, format, true).isValid();
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
      /^\s*-\s\[ \]/.test(l) && l.includes(todo.text)
    );
    if (near >= 0) return near;
    return lines.findIndex(l => /^\s*-\s\[ \]/.test(l) && l.includes(todo.text));
  }

  async deleteTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      const editor = this.getEditorForFile(todo.file);
      if (editor) {
        const lines = editor.getValue().split("\n");
        const idx = this.findTodoLine(lines, todo);
        if (idx >= 0 && lines[idx]?.match(/^(\s*)-\s\[ \]/)) {
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
        if (idx >= 0 && lines[idx]?.match(/^(\s*)-\s\[ \]/)) {
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
        if (idx >= 0 && lines[idx]?.match(/^(\s*)-\s\[ \]/)) {
          const line = lines[idx];
          const col = line.indexOf("- [ ]");
          editor.replaceRange("- [x]", { line: idx, ch: col }, { line: idx, ch: col + 5 });
          this.lastModifiedFile = todo.file;
        }
      } else {
        const content = await this.app.vault.read(todo.file);
        const lines = content.split("\n");
        const idx = this.findTodoLine(lines, todo);
        if (idx >= 0 && lines[idx]?.match(/^(\s*)-\s\[ \]/)) {
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

  async navigateToTodo(todo: TodoItem): Promise<void> {
    let leaf =
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
      (l) => /^\s*-\s\[ \]\s/.test(l) && l.includes(todo.text)
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
      .setName("Sort order")
      .setDesc("How todos are ordered in the panel.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("recent", "Most recently modified")
          .addOption("alpha", "Alphabetical (A–Z)")
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
  }
}
