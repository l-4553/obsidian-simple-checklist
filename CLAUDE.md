# Simple Checklist — agent notes

Obsidian community plugin: vault-wide `- [ ]` todo panel (`src/main.ts`, `styles.css`).

## Release process

Use the release script — it bumps versions, builds, commits, pushes, and tags in one step:

```bash
scripts/release.sh <version> "<commit description>"
```

Example:

```bash
scripts/release.sh 1.8.5 "fix TypeScript ESLint warnings in drag-and-drop code"
```

The script:

1. Bumps `package.json`, `package-lock.json`, and `manifest.json` to the target version
2. Verifies `package.json` and `manifest.json` versions match
3. Runs `npm run build` (outputs `main.js`, gitignored locally)
4. Commits all tracked changes with message `<version>: <description>`
5. Pushes `main` to `origin`
6. Creates and pushes git tag `<version>`

Pushing the tag triggers `.github/workflows/release.yml`, which builds and publishes the GitHub release with:

- `main.js`
- `manifest.json`
- `styles.css`

Check the workflow and release after pushing:

- Actions: `https://github.com/l-4553/obsidian-simple-checklist/actions`
- Releases: `https://github.com/l-4553/obsidian-simple-checklist/releases`

### Prerequisites

- Write access to `origin` (this repo uses `git@github-priv:l-4553/obsidian-simple-checklist.git`)
- Tag must not already exist locally or on `origin`
- Any pending changes are folded into the release commit — review `git status` first

### Manual fallback

If only the tag failed to push (branch already on `origin`):

```bash
git push
git tag <version>
git push origin <version>
```

## Local development

```bash
npm install
npm run build    # production bundle → main.js
npm run dev      # watch mode
```

## Key files

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin logic, settings, checklist view |
| `styles.css` | Panel styles (shipped in release) |
| `manifest.json` | Obsidian plugin manifest (version must match release tag) |
| `scripts/release.sh` | Version bump + build + commit + push + tag |
