import type { TFile } from "obsidian";

export function formatNoteTitle(file: Pick<TFile, "basename" | "parent">, showParentFolder: boolean): string {
  const parent = file.parent;
  return showParentFolder && parent && parent.path !== "/"
    ? `${parent.name} / ${file.basename}`
    : file.basename;
}
