# Simpel Checklist

An Obsidian plugin that collects all open `- [ ]` todos across your vault into a single side panel.

## Features

- **Vault-wide todo list** — scans every Markdown file and surfaces unchecked `- [ ]` items in one place
- **Grouped by file** — todos are grouped under their source file, sorted by most recently modified
- **Click to navigate** — click a todo to jump directly to that line in the source file
- **Complete from the panel** — check off a todo; it gets marked `- [x]` in the file, with a small confetti burst
- **Delete from the panel** — remove a todo from the file entirely using the trash icon
- **Inline link rendering** — wiki links (`[[Note]]`) and Markdown links inside todo text are rendered as clickable links
- **Live updates** — the panel refreshes automatically as you edit your notes

## Usage

Open the checklist panel via:
- The checklist icon in the left ribbon
- The command palette: **Open Checklist panel**

## Installation

### Community plugins (recommended)

Search for **Simpel Checklist** in Settings → Community plugins → Browse.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Copy them to `<vault>/.obsidian/plugins/obsidian-checklist/`
3. Enable the plugin in Settings → Community plugins

## Todo format

The plugin picks up any line matching `- [ ] …`, including indented items:

```markdown
- [ ] Buy groceries
  - [ ] Nested todo
- [x] Already done (ignored)
```
