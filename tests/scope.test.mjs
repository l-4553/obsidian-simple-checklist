import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  write: false,
});

class TFile {
  constructor(path) { this.path = path; this.stat = { mtime: 0 }; }
  get extension() { return this.path.split(".").at(-1); }
  get basename() { return this.path.split("/").at(-1).replace(/\.[^.]+$/, ""); }
}

class Events {
  listeners = new Map();
  on(name, callback) {
    const callbacks = this.listeners.get(name) ?? [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
    return { name, callback };
  }
  async emit(name, ...args) {
    for (const callback of this.listeners.get(name) ?? []) await callback(...args);
  }
}

class Plugin {
  constructor(app) { this.app = app; }
  async loadData() { return this.storedData ?? null; }
  async saveData(data) { this.storedData = JSON.parse(JSON.stringify(data)); }
  registerEvent() {}
  registerView(type, factory) { this.viewFactory = factory; }
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab(tab) { this.settingTab = tab; }
}

const obsidian = {
  Plugin,
  TFile,
  ItemView: class {},
  MarkdownView: class {},
  PluginSettingTab: class {},
  moment: require("moment"),
};
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  require: (id) => id === "obsidian" ? obsidian : require(id),
});
const ChecklistPlugin = module.exports.default;

async function fixture() {
  const content = new Map([
    ["Inbox.md", "- [ ] Root task"],
    ["Projects/App/Plan.md", "- [ ] Parent\n  - [ ] Child\n- [ ] Urgent !!\n- [x] Done"],
    ["Projects/App/Other.md", "- [ ] Sibling task"],
    ["Projects/App/Sub/Deep.md", "> [!todo]\n> - [ ] Nested folder task"],
    ["Projects/App-old/Plan.md", "- [ ] Different folder task"],
    ["Projects/Elsewhere.md", "- [ ] Outside task"],
    ["研究/计划.md", "- [ ] Unicode task"],
  ]);
  const files = new Map(Array.from(content.keys(), (path) => [path, new TFile(path)]));
  const vault = Object.assign(new Events(), {
    getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
    getAbstractFileByPath: (path) => files.get(path) ?? null,
    cachedRead: async (file) => content.get(file.path) ?? "",
  });
  const workspace = Object.assign(new Events(), {
    activeFile: files.get("Projects/App/Plan.md"),
    getActiveFile() { return this.activeFile; },
    getLeavesOfType: () => [],
    onLayoutReady: () => {},
  });
  const plugin = new ChecklistPlugin({ vault, workspace });
  await plugin.buildIndex();
  return { plugin, workspace, vault, files, content };
}

function paths(plugin) {
  return Array.from(new Set(plugin.getAllTodos().map((todo) => todo.file.path))).sort();
}

test("existing installations default to the whole vault without an active note", async () => {
  const { plugin, workspace, files } = await fixture();
  await plugin.loadSettings();
  workspace.activeFile = null;
  assert.equal(plugin.settings.todoScope, "vault");
  assert.deepEqual(paths(plugin), [...files.keys()].sort());
});

test("current note keeps priority, nesting, and completion filtering", async () => {
  const { plugin } = await fixture();
  plugin.settings.todoScope = "note";
  assert.deepEqual(paths(plugin), ["Projects/App/Plan.md"]);
  assert.deepEqual(Array.from(plugin.getAllTodos(), ({ text, depth }) => [text, depth]), [
    ["Urgent !!", 0], ["Parent", 0], ["Child", 1],
  ]);
});

test("folder scope includes siblings and descendants but excludes prefix collisions", async () => {
  const { plugin } = await fixture();
  plugin.settings.todoScope = "folder";
  assert.deepEqual(paths(plugin), [
    "Projects/App/Other.md", "Projects/App/Plan.md", "Projects/App/Sub/Deep.md",
  ]);
  assert.equal(plugin.getScopeContext(), "Projects/App/");
});

test("root folder scope includes the entire vault", async () => {
  const { plugin, workspace, files } = await fixture();
  plugin.settings.todoScope = "folder";
  workspace.activeFile = files.get("Inbox.md");
  assert.deepEqual(paths(plugin), [...files.keys()].sort());
  assert.equal(plugin.getScopeContext(), "/ (vault root, including subfolders)");
});

test("note and folder scopes follow the active note, including Unicode paths", async () => {
  const { plugin, workspace, files } = await fixture();
  for (const scope of ["note", "folder"]) {
    plugin.settings.todoScope = scope;
    workspace.activeFile = files.get("研究/计划.md");
    assert.deepEqual(paths(plugin), ["研究/计划.md"]);
    workspace.activeFile = files.get("Projects/App/Sub/Deep.md");
    assert.deepEqual(paths(plugin), ["Projects/App/Sub/Deep.md"]);
  }
});

test("scoped views prompt for a note when the active file is missing, deleted, or non-Markdown", async () => {
  const { plugin, workspace } = await fixture();
  for (const scope of ["note", "folder"]) {
    plugin.settings.todoScope = scope;
    for (const file of [null, new TFile("Image.png"), new TFile("Deleted.md")]) {
      workspace.activeFile = file;
      assert.deepEqual(paths(plugin), []);
      assert.match(plugin.getEmptyMessage(), /Open a Markdown note/);
    }
  }
});

test("existing exclusion filters still apply within each scope", async () => {
  const { plugin } = await fixture();
  plugin.settings.todoScope = "folder";
  plugin.settings.excludeRules = "Projects/App/Sub/\nProjects/App/Other.md\nUrgent";
  assert.deepEqual(paths(plugin), ["Projects/App/Plan.md"]);
  assert.deepEqual(Array.from(plugin.getAllTodos(), (todo) => todo.text), ["Parent", "Child"]);
  plugin.settings.excludeRules = "Projects/App/";
  assert.deepEqual(paths(plugin), []);
  assert.match(plugin.getEmptyMessage(), /current filters/);
});

test("date filters intersect with the selected scope", async () => {
  const { plugin, files, content } = await fixture();
  const path = "Projects/App/2020-01-01.md";
  files.set(path, new TFile(path));
  content.set(path, "- [ ] Daily task");
  await plugin.buildIndex();
  plugin.settings.todoScope = "folder";
  plugin.settings.dateNotesOnly = true;
  plugin.settings.hideFutureDateNotes = true;
  assert.deepEqual(paths(plugin), [path]);
});

test("scope choice is persisted and invalid stored choices fall back to the vault", async () => {
  const { plugin } = await fixture();
  await plugin.updateSetting("todoScope", "folder");
  plugin.settings.todoScope = "vault";
  await plugin.loadSettings();
  assert.equal(plugin.settings.todoScope, "folder");
  for (const invalid of ["bogus", "toString", null]) {
    plugin.storedData = { todoScope: invalid };
    await plugin.loadSettings();
    assert.equal(plugin.settings.todoScope, "vault");
  }
});

test("legacy keyword migration is preserved", async () => {
  const { plugin } = await fixture();
  plugin.storedData = { excludeKeywords: "alpha, beta" };
  await plugin.loadSettings();
  assert.equal(plugin.settings.excludeRules, "alpha\nbeta");
  assert.equal(plugin.settings.todoScope, "vault");
});

test("tab changes and same-tab opens refresh scoped views without rescanning", async () => {
  const { plugin, workspace } = await fixture();
  await plugin.onload();
  let renders = 0;
  plugin.refreshView = () => { renders++; };
  plugin.buildIndex = () => { throw new Error("Scope changes must use the existing index"); };
  for (const scope of ["note", "folder"]) {
    plugin.settings.todoScope = scope;
    await workspace.emit("file-open", workspace.activeFile);
    await workspace.emit("active-leaf-change", null);
  }
  assert.equal(renders, 4);
  plugin.settings.todoScope = "vault";
  await workspace.emit("file-open", workspace.activeFile);
  await workspace.emit("active-leaf-change", null);
  assert.equal(renders, 4);
});

test("new notes with existing tasks enter the current folder scope", async () => {
  const { plugin, vault, files, content } = await fixture();
  await plugin.onload();
  plugin.settings.todoScope = "folder";
  const file = new TFile("Projects/App/New.md");
  files.set(file.path, file);
  content.set(file.path, "- [ ] Created task");
  await vault.emit("create", file);
  assert.ok(paths(plugin).includes(file.path));
});

test("moving or renaming a note updates scope membership immediately", async () => {
  const { plugin, vault, files, content } = await fixture();
  await plugin.onload();
  plugin.settings.todoScope = "folder";
  const file = files.get("Projects/App/Other.md");
  const oldPath = file.path;
  files.delete(oldPath);
  file.path = "Outside/Other.md";
  files.set(file.path, file);
  content.set(file.path, content.get(oldPath));
  await vault.emit("rename", file, oldPath);
  assert.deepEqual(paths(plugin), ["Projects/App/Plan.md", "Projects/App/Sub/Deep.md"]);
});

test("renaming the active folder reindexes descendants and updates the scope path", async () => {
  const { plugin, vault, files, content } = await fixture();
  await plugin.onload();
  plugin.settings.todoScope = "folder";
  for (const [oldPath, file] of [...files]) {
    if (!oldPath.startsWith("Projects/App/")) continue;
    files.delete(oldPath);
    file.path = oldPath.replace("Projects/App/", "Projects/Renamed/");
    files.set(file.path, file);
    content.set(file.path, content.get(oldPath));
  }
  await vault.emit("rename", { path: "Projects/Renamed" }, "Projects/App");
  assert.deepEqual(paths(plugin), [
    "Projects/Renamed/Other.md", "Projects/Renamed/Plan.md", "Projects/Renamed/Sub/Deep.md",
  ]);
  assert.equal(plugin.getScopeContext(), "Projects/Renamed/");
});

test("empty scoped results describe the selected scope", async () => {
  const { plugin, files, content, workspace } = await fixture();
  const file = new TFile("Empty/Note.md");
  files.set(file.path, file);
  content.set(file.path, "No tasks");
  workspace.activeFile = file;
  plugin.settings.todoScope = "note";
  assert.deepEqual(paths(plugin), []);
  assert.match(plugin.getEmptyMessage(), /current note/);
  plugin.settings.todoScope = "folder";
  assert.match(plugin.getEmptyMessage(), /current folder/);
});
