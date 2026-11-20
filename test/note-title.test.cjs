const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { before, test } = require("node:test");
const { transformSync } = require("esbuild");

let formatNoteTitle;
before(async () => {
  const source = readFileSync("src/note-title.ts", "utf8");
  const { code } = transformSync(source, { loader: "ts", format: "esm" });
  ({ formatNoteTitle } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`));
});

test("includes the immediate parent when enabled", () => {
  const file = { basename: "2026-11", parent: { name: "Alex", path: "People/Alex" } };
  assert.equal(formatNoteTitle(file, true), "Alex / 2026-11");
  assert.equal(formatNoteTitle(file, false), "2026-11");
});

test("keeps root-level or parentless notes unprefixed", () => {
  assert.equal(formatNoteTitle({ basename: "Home", parent: { name: "/", path: "/" } }, true), "Home");
  assert.equal(formatNoteTitle({ basename: "Home", parent: null }, true), "Home");
});
