# Simple Checklist
<img width="1080" height="813" alt="showcasing" src="https://github.com/user-attachments/assets/9102635f-ad51-4fee-80bc-d0918cdea42a" />

An Obsidian plugin that collects all open `- [ ]` todos across your vault into a single side panel.

## Features

- **Vault-wide todo list** — scans every Markdown file and surfaces unchecked `- [ ]` items in one place
- **Grouped by file** — todos are grouped under their source file; click a group title to open that note
- **Nested indentation** — sub-todos are indented in the panel to mirror their nesting in the note
- **Click to navigate** — click a todo to jump directly to that line in the source file
- **Complete from the panel** — check off a todo; it gets marked `- [x]` in the file, with a small confetti burst
- **Delete from the panel** — remove a todo from the file entirely using the trash icon
- **Pin notes to the top** — pin a note group so it stays above the rest, regardless of sort order
- **Drag and drop** — move a todo from one note into another by dragging it between groups; its nested sub-todos are carried along
- **Callout support** — todos written inside callouts (`> - [ ]`) are picked up too, with their callout header preserved
- **Inline rendering** — wiki links (`[[Note]]`), Markdown links, and inline code (`` `code` ``) inside todo text are rendered inline
- **Priority by `!`** — todos ending in `!` float to the top of their note, with `!!` above `!` above none
- **Live updates** — the panel refreshes automatically as you edit your notes

## Settings

- **Note sort order** — order groups by most/least recently modified, or note name (A–Z / Z–A)
- **Date notes only** — show todos only from notes whose filename matches your Daily Notes date format
- **Exclude keywords** — hide todos containing any of the given comma-separated keywords (case-insensitive)
- **Roll over open todos** — when today's daily note is created, move open todos from past daily notes into it (callout headers are carried along)

## Usage

Open the checklist panel via:
- The checklist icon in the left ribbon
- The command palette: **Open Checklist panel**

## Installation

Search for **Simple Checklist** in Settings → Community plugins → Browse.

Or add via [community.obsidian.md/plugins/simple-checklist](https://community.obsidian.md/plugins/simple-checklist)
