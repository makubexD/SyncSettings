import type { Os } from "../config/types.ts";
import type { LayerName } from "../layers/select.ts";
import type { ChangeLine } from "./types.ts";

/** The line an empty group prints, indented to the kind column. */
const EMPTY_GROUP = "(none)";

/** The group title's OS word (contract "Push preview (program only)"). */
export const OS_TITLES: Readonly<Record<Os, string>> = {
  linux: "Linux",
  windows: "Windows",
  macos: "macOS",
};

/** One group of the block: its title and the lines that belong to it. */
interface BlockGroup {
  readonly title: string;
  readonly lines: readonly ChangeLine[];
}

/** The column widths every line of the block is padded to. */
interface BlockWidths {
  readonly number: number;
  readonly module: number;
  readonly file: number;
}

/**
 * The groups the block prints, in display order, each with the lines of its
 * layer. Without a record there is no profile or machine layer, so only the
 * first two groups print and lines of the other two are left out.
 */
function groupsOf(
  lines: readonly ChangeLine[],
  record: { readonly name: string; readonly profile: string } | undefined,
  os: Os,
): readonly BlockGroup[] {
  const titles: (readonly [string, LayerName])[] = [
    ["All machines", "base"],
    [`${OS_TITLES[os]} machines`, "os"],
  ];
  if (record !== undefined) {
    titles.push(
      [`Profile ${record.profile}`, "profile"],
      ["This machine only", "machine"],
    );
  }
  return titles.map(([title, layer]) => ({
    title,
    lines: lines.filter((line) => line.layer === layer),
  }));
}

/** The block's header line (contract "Push preview (program only)"). */
function headerOf(
  record: { readonly name: string; readonly profile: string } | undefined,
  header: "push" | "pull",
): string {
  if (header === "pull") {
    return "Changes from the repo:";
  }
  if (record === undefined) {
    return "Changes on this machine:";
  }
  return `Changes on ${record.name} (profile ${record.profile}):`;
}

/** The widest value `of` returns over `lines`, or 0 for no lines. */
function widestOf(
  lines: readonly ChangeLine[],
  of: (line: ChangeLine) => string,
): number {
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, of(line).length);
  }
  return width;
}

/** One change's line, numbered and padded to the block's columns. */
function formatLine(
  line: ChangeLine,
  number: number,
  widths: BlockWidths,
): string {
  const printedNumber = String(number).padStart(widths.number);
  const module = line.module.padEnd(widths.module);
  const file = line.file.padEnd(widths.file);
  return `  ${printedNumber}  ${line.kind}  ${module}  ${file}  ${line.what}`;
}

/**
 * The grouped block of the push preview and the import check: the header, a
 * blank line, each group with its numbered lines or `(none)`, and a trailing
 * blank line (contract "Push preview (program only)"). Numbers run from 1 in
 * display order across the groups; input order is kept within a group.
 */
export function groupBlock(
  lines: readonly ChangeLine[],
  record: { readonly name: string; readonly profile: string } | undefined,
  os: Os,
  header: "push" | "pull",
): readonly string[] {
  const groups = groupsOf(lines, record, os);
  const shown = groups.flatMap((group) => group.lines);
  const widths: BlockWidths = {
    number: String(Math.max(shown.length, 1)).length,
    module: widestOf(shown, (line) => line.module),
    file: widestOf(shown, (line) => line.file),
  };
  const noneIndent = " ".repeat(2 + widths.number + 2);

  const block: string[] = [headerOf(record, header), ""];
  let number = 0;
  for (const group of groups) {
    block.push(group.title);
    if (group.lines.length === 0) {
      block.push(`${noneIndent}${EMPTY_GROUP}`);
      continue;
    }
    for (const line of group.lines) {
      number += 1;
      block.push(formatLine(line, number, widths));
    }
  }
  block.push("");
  return block;
}
