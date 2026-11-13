# Simple Checklist
<img width="1080" height="813" alt="showcasing" src="https://github.com/user-attachments/assets/9102635f-ad51-4fee-80bc-d0918cdea42a" />

An actively maintained Obsidian plugin that collects all open `- [ ]` todos across your vault into a single side panel.

## Features

- **Every open todo in one panel** — scans every Markdown file and surfaces unchecked `- [ ]` items in one place, or only those from the current note or folder
- **Check off without leaving your note** — tick a todo in the panel and it's marked `- [x]` in the file, with a small confetti burst. Checked-off todos stay in the panel, greyed out, for 5 seconds before they fade away; click the checkbox again in that time to uncheck them
- **Completed todos** — optionally keep todos checked off today, in the last 3, 7 or 30 days, this week, this month or ever in the panel, greyed out below their note's or heading's open todos; they stay linked to their line when it shifts, is edited or moved to another note
- **Priority by `!`** — todos ending in `!` float to the top of their note, with `!!` above `!` above none; todos containing a `==highlight==` come next, above plain todos
- **Drag and drop** — reorder todos or move them into another note by dragging; an accent-colored line shows exactly where the todo will land (above or below a todo), and its nested sub-todos are carried along
- **Daily note rollover** — optionally move open todos from past daily notes into today's note, when it's created or as soon as you turn the setting on
- **Focused filters** — limit the panel to date notes, hide future-dated notes, or exclude todos by word, folder, note or regular expression
- **Click to navigate** — click a todo to jump directly to that line in the source file
- **Pin notes to the top** — pin a note group so it stays above the rest, regardless of sort order
- **Fold notes and headings** — hover a note title or heading and click the arrow on its left to fold the todos below it; click again to unfold. Folds are remembered
- **Inline rendering** — wiki links (`[[Note]]`), Markdown links, inline code (`` `code` ``), **bold** (`**text**`), *italic* (`*text*`), ~~strikethrough~~ (`~~text~~`), LaTeX math (`$x^2$`, `$$…$$`) and highlights (`==text==`) inside todo text are rendered inline, including Obsidian's highlight colors (`==🟢text==`)
- **Delete from the panel** — remove a todo from the file entirely using the trash icon
- **Undo** — press Cmd+Z (Ctrl+Z on Windows/Linux) while the panel is focused to undo the last check-off, delete or move made in the panel; press it repeatedly to step further back, also across notes
- **Grouped by file** — todos are grouped under their source file; click a group title to open that note
- **Grouped by heading** — optionally show each todo under the nearest heading above it in the note; click a heading to jump to it
- **Nested indentation** — sub-todos are indented in the panel to mirror their nesting in the note
- **Live updates** — the panel refreshes automatically as you edit your notes

## Settings

### Display

- **Note sort order** — order groups by most/least recently modified, or note name (A–Z / Z–A)
- **Show note titles** (on by default) — group todos under their note's title. When off, only the todos are shown and dragging only reorders within a note. Also toggled from the panel header button or the **Toggle note titles in Checklist panel** command
- **Show headings** (off by default) — group todos under the nearest heading above them; click a heading to jump to it. Priority sorting then applies per heading
- **Show completed todos** — **None** (default), **Today**, **Last 3 days**, **This week**, **Last 7 days**, **This month**, **Last 30 days** or **All**. Todos checked off in that time span stay in the panel, greyed out below the open todos of their note (or of their heading, with **Show headings** on), most recently checked off first; click the checkbox to uncheck one. The time a todo is checked off (in the panel or the note) is always recorded for the last 30 days, so switching the setting shows past completions right away. **All** also shows every other checked-off todo in your notes. A completed todo stays linked to its line when lines shift, the note is renamed, the todo is edited or moved to another note

### Filters

- **Todo scope** — **Entire vault** (default), **Current note**, or **Current folder and subfolders**. Note and folder scopes follow the active note; date and exclusion filters still apply within the scope.
- **Date notes only** — show todos only from notes whose filename matches your Daily Notes date format (formats with folders, e.g. `YYYY/MM/YYYY-MM-DD`, are supported)
- **Hide future date notes** — hide todos from date notes dated after today, so planning-ahead notes stay out of the panel
- **Exclude todos** — hide todos from the panel, one rule per line; the shape of a line decides what it matches:

  | Line | Hides |
  |---|---|
  | `define` | todos containing the text, even inside a longer word like `undefined` (case-insensitive) |
  | `Templates/` | every note in the folder and its subfolders |
  | `Projects/Games backlog.md` | that note |
  | `/weekly planner/` | notes whose path matches the regular expression (case-insensitive); an invalid one is flagged in the settings and the box isn't saved until it's fixed |

### Checking off

- **Check off nested todos** — when you check off a todo in the panel, also check off the open todos indented beneath it

### Daily notes

- **Roll over open todos** — when today's daily note is created, move open todos from past daily notes into it (callout headers are carried along). Turning the setting on runs this right away, creating today's note if needed

## Usage

Open the checklist panel via:
- The checklist icon in the left ribbon
- The command palette: **Open Checklist panel**

## Installation

Search for **Simple Checklist** in Settings → Community plugins → Browse.

Or add via [community.obsidian.md/plugins/simple-checklist](https://community.obsidian.md/plugins/simple-checklist)
