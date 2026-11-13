/** A profile or machine name: lowercase letters, digits and `-`. */
export const LAYER_NAME = /^[a-z0-9-]+$/;

/** Layer names a profile or machine may not take: they name another layer. */
export const RESERVED_LAYER_NAMES: readonly string[] = [
  "linux",
  "macos",
  "windows",
  "common",
  "base",
];
