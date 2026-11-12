import type { MergeType } from "../config/types.ts";
import type { MergeStrategy } from "./types.ts";
import { WHOLE } from "./whole.ts";

/**
 * The strategy for a merge type. `json` and `import` come in later steps of
 * phase 5; `dir` and `dconf` stay with the plans (phase 8), so they have no
 * strategy yet.
 */
export function strategyFor(merge: MergeType): MergeStrategy | undefined {
  switch (merge) {
    case "whole":
      return WHOLE;
    case "json":
    case "import":
    case "dconf":
    case "dir":
      return undefined;
    default: {
      const unhandled: never = merge;
      throw new Error(`Unhandled merge type: ${String(unhandled)}`);
    }
  }
}
