import {
  Editor,
  ItemView,
  MarkdownView,
  Plugin,
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
  const rect = originEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 14; i++) {
    const el = document.createElement("div");
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
    document.body.appendChild(el);
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

  constructor(leaf: WorkspaceLeaf, plugin: ChecklistPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "Checklist"; }
  getIcon(): string { return "check-square"; }
  async onOpen(): Promise<void> { this.render(); }
  async onClose(): Promise<void> {}

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
      if (!this.emptyEl) {
        this.emptyEl = container.createDiv({ cls: "checklist-empty", text: "No open todos." });
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

    // ── Maintain stable display order ────────────────────────────────────────
    // Remove paths no longer present
    this.displayOrder = this.displayOrder.filter(p => grouped.has(p));
    // Collect new paths (not yet in displayOrder), sorted by mtime so newest is first
    const newPaths = [...grouped.keys()]
      .filter(p => !this.displayOrder.includes(p))
      .sort((a, b) => {
        const fa = grouped.get(a)![0].file;
        const fb = grouped.get(b)![0].file;
        return fb.stat.mtime - fa.stat.mtime;
      });
    // Prepend new paths so they appear at the top
    this.displayOrder = [...newPaths, ...this.displayOrder];
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
    checkbox.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (completing) return;
      completing = true;
      spawnConfetti(checkbox);
      this.plugin.suppressRefresh = true;
      await this.plugin.completeTodo(todo);
      row.remove();
      this.rowEls.delete(key);
      if (!groupEl.querySelector(".checklist-item")) {
        groupEl.remove();
        this.groupEls.delete(todo.file.path);
      }
      this.plugin.suppressRefresh = false;
      this.plugin.refreshView();
    });

    const text = row.createDiv({ cls: "checklist-text" });
    renderTodoText(text, todo.text, todo.file.path, (target, subpath, source) => {
      this.plugin.app.workspace.openLinkText(target + subpath, source, false);
    });
    text.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).classList.contains("checklist-inline-link")) {
        this.plugin.navigateToTodo(todo);
      }
    });

    const trash = row.createDiv({ cls: "checklist-trash" });
    setIcon(trash, "trash");
    let deleting = false;
    trash.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (deleting) return;
      deleting = true;
      this.plugin.suppressRefresh = true;
      await this.plugin.deleteTodo(todo);
      row.remove();
      this.rowEls.delete(key);
      if (!groupEl.querySelector(".checklist-item")) {
        groupEl.remove();
        this.groupEls.delete(todo.file.path);
      }
      this.plugin.suppressRefresh = false;
      this.plugin.refreshView();
    });

    return row;
  }
}

export default class ChecklistPlugin extends Plugin {
  private index: Map<string, Array<{ lineIndex: number; text: string }>> = new Map();
  suppressRefresh = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(fn);
    return this.writeQueue;
  }

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new ChecklistView(leaf, this));
    this.addRibbonIcon("check-square", "Open Checklist", () => this.activateView());
    this.addCommand({ id: "open-checklist", name: "Open Checklist panel", callback: () => this.activateView() });

    this.app.workspace.onLayoutReady(async () => {
      await this.buildIndex();
      this.refreshView();
    });

    this.registerEvent(this.app.vault.on("modify", async (file) => {
      if (file instanceof TFile && file.extension === "md") {
        await this.updateIndex(file);
        if (!this.suppressRefresh) this.refreshView();
      }
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

  onunload(): void { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  async buildIndex(): Promise<void> {
    this.index.clear();
    await Promise.all(this.app.vault.getMarkdownFiles().map(f => this.updateIndex(f)));
  }

  async updateIndex(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    const todos: Array<{ lineIndex: number; text: string }> = [];
    content.split("\n").forEach((line, i) => {
      const m = line.match(/^(\s*)-\s\[ \]\s(.+)/);
      if (m) todos.push({ lineIndex: i, text: m[2] });
    });
    if (todos.length > 0) this.index.set(file.path, todos);
    else this.index.delete(file.path);
  }

  getAllTodos(): TodoItem[] {
    const todos: TodoItem[] = [];
    for (const [path, items] of this.index) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      for (const item of items) todos.push({ file, lineIndex: item.lineIndex, text: item.text });
    }
    todos.sort((a, b) => {
      const d = b.file.stat.mtime - a.file.stat.mtime;
      return d !== 0 ? d : a.lineIndex - b.lineIndex;
    });
    return todos;
  }

  async deleteTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      const content = await this.app.vault.read(todo.file);
      const lines = content.split("\n");
      // Find the line by text in case index shifted since click
      const idx = lines.findIndex((l, i) =>
        i >= todo.lineIndex - 2 && i <= todo.lineIndex + 2 &&
        l.match(/^(\s*)-\s\[ \]/) && l.includes(todo.text)
      ) ?? todo.lineIndex;
      if (idx >= 0 && lines[idx]?.match(/^(\s*)-\s\[ \]/)) {
        lines.splice(idx, 1);
        await this.app.vault.modify(todo.file, lines.join("\n"));
      }
    });
  }

  async completeTodo(todo: TodoItem): Promise<void> {
    return this.enqueue(async () => {
      const content = await this.app.vault.read(todo.file);
      const lines = content.split("\n");
      const idx = lines.findIndex((l, i) =>
        i >= todo.lineIndex - 2 && i <= todo.lineIndex + 2 &&
        l.match(/^(\s*)-\s\[ \]/) && l.includes(todo.text)
      ) ?? todo.lineIndex;
      if (idx >= 0 && lines[idx]?.match(/^(\s*)-\s\[ \]/)) {
        lines[idx] = lines[idx].replace("- [ ]", "- [x]");
        await this.app.vault.modify(todo.file, lines.join("\n"));
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
    const lineLength = editor.getLine(todo.lineIndex).length;
    const pos = { line: todo.lineIndex, ch: lineLength };
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);
  }

  refreshView(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof ChecklistView) leaf.view.render();
    });
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
