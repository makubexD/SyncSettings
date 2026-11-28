import type { Profile } from "../config/profile.ts";
import { NONE, showLine } from "./show.ts";

/** A list joined with `, `, or `none` when it is empty. */
function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? NONE : items.join(", ");
}

/** The layer's count, then its files after a colon when there are any. */
function layerLine(layerFiles: readonly string[]): string {
  const count = `${layerFiles.length} file(s)`;
  return layerFiles.length === 0 ? count : `${count}: ${layerFiles.join(", ")}`;
}

/**
 * `mksync profile show`'s lines, per the contract's "mksync profile show":
 * the name, the label when there is one, the profile's own modules, its value
 * keys in code-unit order (never a value) and the layer's entry files, which
 * `layerFiles` holds already in config order. A retired profile adds
 * `retired   yes` last.
 */
export function renderProfileShow(
  profile: Profile,
  layerFiles: readonly string[],
): readonly string[] {
  const lines = [showLine("profile", profile.name)];
  if (profile.label !== undefined) {
    lines.push(showLine("label", profile.label));
  }
  // Default sort compares UTF-16 code units: `<B>` comes before `<a>`.
  const keys = Object.keys(profile.values).sort();
  lines.push(
    showLine("modules", listOrNone(profile.modules)),
    showLine("values", listOrNone(keys)),
    showLine("layer", layerLine(layerFiles)),
  );
  if (profile.retired) {
    lines.push(showLine("retired", "yes"));
  }
  return lines;
}
