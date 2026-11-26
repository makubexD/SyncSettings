import { describe, expect, test } from "bun:test";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import { resolveValues } from "../values/hydrate.ts";
import { inferredValues } from "./infer.ts";
import { scopeFor } from "./pick.ts";
import type { LocalEntry, Snapshot } from "./types.ts";

const HOME = "/home/user";

const FILE_MODE = 0o644;

const PLACEHOLDER = "<YOUR_NAME>";

const LOCAL_NAME = "Ana Lopez";

const CACHED_NAME = "Cached Name";

const REPO_PATH = "dotfiles/common/parity/a.conf";

const LOCAL_PATH = `${HOME}/.config/parity/a.conf`;

const REPO_TEXT = `name = ${PLACEHOLDER}\n`;

const LOCAL_TEXT = `name = ${LOCAL_NAME}\n`;

const RULE = { placeholder: PLACEHOLDER, prompt: "Full name" };

const FILE_ENTRY: ConfigV2Entry = {
  file: "parity/a.conf",
  module: "parity",
  merge: "whole",
  localPath: "~/.config/parity/a.conf",
  description: "Sanitized parity file",
  sanitize: [RULE],
};

const DIR_ENTRY: ConfigV2Entry = {
  file: "parity/a.conf",
  module: "parity",
  merge: "dir",
  localPath: "~/.config/parity/a.conf",
  description: "A folder entry",
  sanitize: [RULE],
};

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function snapshotOf(
  entry: ConfigV2Entry,
  local: string | undefined,
  values: Readonly<Record<string, string>> = {},
): Snapshot {
  const config: ConfigV2 = {
    schemaVersion: 2,
    modules: { parity: { description: "Parity case files" } },
    entries: [entry],
  };
  const localFiles = new Map<string, LocalEntry>();
  if (local !== undefined) {
    localFiles.set(LOCAL_PATH, {
      kind: "file",
      path: LOCAL_PATH,
      bytes: bytes(local),
      mode: FILE_MODE,
    });
  }
  return {
    config,
    os: "linux",
    home: HOME,
    cwd: HOME,
    repoFiles: new Map([[REPO_PATH, bytes(REPO_TEXT)]]),
    localFiles,
    localDirs: new Set(),
    values,
    env: {},
    only: [],
  };
}

function inferredFor(snapshot: Snapshot): Readonly<Record<string, string>> {
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  return inferredValues(snapshot, selected.value);
}

describe("inferredValues", () => {
  test("should read a value from the local file against the repo's placeholder", () => {
    // Arrange
    const snapshot = snapshotOf(FILE_ENTRY, LOCAL_TEXT);

    // Act
    const inferred = inferredFor(snapshot);

    // Assert
    expect(inferred).toEqual({ [PLACEHOLDER]: LOCAL_NAME });
  });

  test("should leave a cached value first when resolved", () => {
    // Arrange
    const snapshot = snapshotOf(FILE_ENTRY, LOCAL_TEXT, {
      [PLACEHOLDER]: CACHED_NAME,
    });

    // Act
    const resolved = resolveValues(
      [RULE],
      snapshot.values,
      inferredFor(snapshot),
      snapshot.env,
    );

    // Assert
    expect(resolved).toEqual({
      ok: true,
      value: { [PLACEHOLDER]: CACHED_NAME },
    });
  });

  test("should infer nothing when the local file is missing", () => {
    // Arrange
    const snapshot = snapshotOf(FILE_ENTRY, undefined);

    // Act
    const inferred = inferredFor(snapshot);

    // Assert
    expect(inferred).toEqual({});
  });

  test("should skip a dir entry", () => {
    // Arrange
    const snapshot = snapshotOf(DIR_ENTRY, LOCAL_TEXT);

    // Act
    const inferred = inferredFor(snapshot);

    // Assert
    expect(inferred).toEqual({});
  });
});
