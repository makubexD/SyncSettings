import type { Os } from "../config/types.ts";
import type { LayerName } from "../layers/select.ts";
import type { ChangeLine, NewSettingLine } from "./types.ts";

/** The line an empty group prints, indented to the kind column. */
const EMPTY_GROUP = "(none)";

/** The title of the block's last section, the new settings. */
const NEW_SETTINGS_TITLE = "New settings";

/** The kind column a new setting prints, which has no change kind of its own. */
const NEW_SETTING_KIND = "+";

/** The grouped block's parts: its lines up to the new settings, one line per
 * new setting, and the indent that reaches the kind column. */
export interface GroupedBlock {
  readonly head: readonly string[];
  readonly settings: readonly string[];
  readonly indent: string;
}

/** The columns every line of the block pads: a change line or a new setting. */
interface BlockLine {
  readonly kind: string;
  readonly module: string;
  readonly file: string;
  readonly what: string;
}

/** The group title's OS word (contract "Push preview (program only)"). */
export const OS_TITLES: Readonly<Record<Os, string>> = {
  linux: "Linux",
  windows: "Windows",
  macos: "macOS",
};

/** One change line the block prints: the line, its position in the input, and
 * the display number the block gives it. */
interface NumberedLine {
  readonly line: ChangeLine;
  readonly index: number;
  readonly number: number;
}

/** One group of the block: its title and the numbered lines that belong to it. */
interface BlockGroup {
  readonly title: string;
  readonly lines: readonly NumberedLine[];
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
  let number = 0;
  return titles.map(([title, layer]) => {
    const numbered: NumberedLine[] = [];
    lines.forEach((line, index) => {
      if (line.layer !== layer) {
        return;
      }
      number += 1;
      numbered.push({ line, index, number });
    });
    return { title, lines: numbered };
  });
}

/**
 * The display number `groupBlock` gives each change line it prints, parallel to
 * `lines`; a line the block leaves out (a profile or machine line without a
 * record) has 0. The numbering's one home, for the block and the profile-value
 * rule (contract "Push preview (program only)").
 */
export function changeLineNumbers(
  lines: readonly ChangeLine[],
  record: { readonly name: string; readonly profile: string } | undefined,
  os: Os,
): readonly number[] {
  const numbers = new Array<number>(lines.length).fill(0);
  for (const group of groupsOf(lines, record, os)) {
    for (const item of group.lines) {
      numbers[item.index] = item.number;
    }
  }
  return numbers;
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
  lines: readonly { readonly module: string; readonly file: string }[],
  of: (line: { readonly module: string; readonly file: string }) => string,
): number {
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, of(line).length);
  }
  return width;
}

/** One change's or new setting's line, numbered and padded to the block's
 * columns. */
function formatLine(
  line: BlockLine,
  number: number,
  widths: BlockWidths,
): string {
  const printedNumber = String(number).padStart(widths.number);
  const module = line.module.padEnd(widths.module);
  const file = line.file.padEnd(widths.file);
  return `  ${printedNumber}  ${line.kind}  ${module}  ${file}  ${line.what}`;
}

/**
 * The grouped block split into its parts: the header, a blank line, each group
 * with its numbered lines or `(none)`, then a blank line and `New settings`
 * when there are any, with one numbered line per new setting. Numbers and
 * widths run over the change lines and the new settings together, the settings
 * numbered after the groups (contract "Push preview", "New settings").
 */
export function groupedBlock(
  lines: readonly ChangeLine[],
  record: { readonly name: string; readonly profile: string } | undefined,
  os: Os,
  header: "push" | "pull",
  newSettings: readonly NewSettingLine[],
): GroupedBlock {
  const groups = groupsOf(lines, record, os);
  const shown = groups.flatMap((group) => group.lines.map((item) => item.line));
  const numbered = [...shown, ...newSettings];
  const widths: BlockWidths = {
    number: String(Math.max(numbered.length, 1)).length,
    module: widestOf(numbered, (line) => line.module),
    file: widestOf(numbered, (line) => line.file),
  };
  const indent = " ".repeat(2 + widths.number + 2);

  const head: string[] = [headerOf(record, header), ""];
  let number = shown.length;
  for (const group of groups) {
    head.push(group.title);
    if (group.lines.length === 0) {
      head.push(`${indent}${EMPTY_GROUP}`);
      continue;
    }
    for (const item of group.lines) {
      head.push(formatLine(item.line, item.number, widths));
    }
  }

  const settings = newSettings.map((setting) => {
    number += 1;
    return formatLine(
      {
        kind: NEW_SETTING_KIND,
        module: setting.module,
        file: setting.file,
        what: setting.what,
      },
      number,
      widths,
    );
  });
  if (newSettings.length > 0) {
    head.push("", NEW_SETTINGS_TITLE);
  }
  return { head, settings, indent };
}

/**
 * The grouped block of the push preview and the import check: the header, a
 * blank line, each group with its numbered lines or `(none)`, then the new
 * settings each followed by its note, and a trailing blank line (contract
 * "Push preview (program only)", "New settings (program only)"). Numbers run
 * from 1 in display order across the groups, then on through the settings;
 * input order is kept within a group.
 */
export function groupBlock(
  lines: readonly ChangeLine[],
  record: { readonly name: string; readonly profile: string } | undefined,
  os: Os,
  header: "push" | "pull",
  newSettings: readonly NewSettingLine[] = [],
  notes: readonly string[] = [],
): readonly string[] {
  const grouped = groupedBlock(lines, record, os, header, newSettings);
  if (newSettings.length === 0) {
    return [...grouped.head, ""];
  }
  const block: string[] = [...grouped.head];
  grouped.settings.forEach((line, index) => {
    block.push(line);
    const note = notes[index];
    if (note !== undefined) {
      block.push(`${grouped.indent}${note}`);
    }
  });
  block.push("");
  return block;
}

/** The change lines with the answered new settings dropped: a setting listed
 * under `New settings` isn't repeated in its layer's group. */
export function withoutNewSettings(
  lines: readonly ChangeLine[],
  settings: readonly NewSettingLine[],
): readonly ChangeLine[] {
  return lines.filter(
    (line) =>
      !settings.some(
        (setting) =>
          setting.module === line.module &&
          setting.file === line.file &&
          setting.what === line.what,
      ),
  );
}
