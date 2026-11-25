import { jsonEqual } from "./value.ts";
import type { JsonValue } from "./value.ts";

/** Whether `after` holds nothing `before` doesn't: equal, or with object keys
 * or array items taken out at any depth. */
export function onlyRemoves(before: JsonValue, after: JsonValue): boolean {
  if (before.kind === "object" && after.kind === "object") {
    return [...after.entries].every(([key, value]) => {
      const old = before.entries.get(key);
      return old !== undefined && onlyRemoves(old, value);
    });
  }
  if (before.kind === "array" && after.kind === "array") {
    const left = [...before.items];
    return after.items.every((item) => {
      const index = left.findIndex((old) => jsonEqual(old, item));
      if (index < 0) {
        return false;
      }
      left.splice(index, 1);
      return true;
    });
  }
  return jsonEqual(before, after);
}
