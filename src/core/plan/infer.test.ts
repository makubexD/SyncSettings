import { describe, expect, test } from "bun:test";
import type { ConfigV2, ConfigV2Entry } from "../config/types.ts";
import { selectEntries } from "../layers/select.ts";
import { resolveValues } from "../values/hydrate.ts";
import { exportInferredValues, inferredValues } from "./infer.ts";
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

const JSON_PATH_PLACEHOLDER = "<WORK_ROOT>";

const JSON_RULE = { placeholder: JSON_PATH_PLACEHOLDER, prompt: "Work root" };

const JSON_ENTRY: ConfigV2Entry = {
  ...FILE_ENTRY,
  merge: "json",
  sanitize: [JSON_RULE],
};

const ENV_NAME = "PARITY_BASE";

const ENV_VALUE = "/srv/base";

const RULE_DEFAULT = "Default Name";

function exportInferredFor(
  snapshot: Snapshot,
): Readonly<Record<string, string>> {
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  return exportInferredValues(snapshot, selected.value);
}

describe("exportInferredValues", () => {
  test("should JSON-unescape a value read from a json entry", () => {
    // Arrange
    const snapshot: Snapshot = {
      ...snapshotOf(JSON_ENTRY, '{ "root": "C:\\\\work" }\n'),
      repoFiles: new Map([
        [REPO_PATH, bytes(`{ "root": "${JSON_PATH_PLACEHOLDER}" }\n`)],
      ]),
    };

    // Act
    const inferred = exportInferredFor(snapshot);

    // Assert
    expect(inferred).toEqual({ [JSON_PATH_PLACEHOLDER]: "C:\\work" });
  });

  test("should leave a placeholder to its defaultEnv when the variable is set", () => {
    // Arrange
    const entry: ConfigV2Entry = {
      ...FILE_ENTRY,
      sanitize: [{ ...RULE, defaultEnv: ENV_NAME }],
    };
    const snapshot: Snapshot = {
      ...snapshotOf(entry, LOCAL_TEXT),
      env: { [ENV_NAME]: ENV_VALUE },
    };

    // Act
    const inferred = exportInferredFor(snapshot);

    // Assert
    expect(inferred).toEqual({});
  });

  test("should put an inferred value before the rule's default when resolved", () => {
    // Arrange
    const rule = { ...RULE, default: RULE_DEFAULT };
    const snapshot = snapshotOf(
      { ...FILE_ENTRY, sanitize: [rule] },
      LOCAL_TEXT,
    );

    // Act
    const resolved = resolveValues(
      [rule],
      snapshot.values,
      exportInferredFor(snapshot),
      snapshot.env,
    );

    // Assert
    expect(resolved).toEqual({
      ok: true,
      value: { [PLACEHOLDER]: LOCAL_NAME },
    });
  });
});

describe("found gh path", () => {
  const ghRule = {
    placeholder: "<GH_CLI_PATH>",
    prompt: "Path to GitHub CLI executable",
    default: "/usr/local/bin/gh",
    suggest: ["gh-path" as const],
  };
  const foundGh = "/usr/bin/gh";

  test.each([
    ["pull", inferredFor],
    ["push", exportInferredFor],
  ])("should infer the found gh path on %s", (_label, infer) => {
    // Arrange
    const snapshot = {
      ...snapshotOf({ ...FILE_ENTRY, sanitize: [RULE, ghRule] }, LOCAL_TEXT),
      ghPath: foundGh,
    };

    // Act
    const inferred = infer(snapshot);

    // Assert
    expect(inferred).toEqual({
      [PLACEHOLDER]: LOCAL_NAME,
      "<GH_CLI_PATH>": foundGh,
    });
  });
});
