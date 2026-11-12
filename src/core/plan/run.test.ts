import { describe, expect, test } from "bun:test";
import type { ConfigV2 } from "../config/types.ts";
import { formatLine } from "../status.ts";
import { planExport } from "./export.ts";
import { planImport } from "./import.ts";
import { renderRun } from "./run.ts";
import { NO_FAILURES } from "./types.ts";
import type { LocalEntry, RunOutcome, RunPlan, Snapshot } from "./types.ts";

const HOME = "/home/user";

const REPO_A = "dotfiles/common/parity/a.conf";

const REPO_B = "dotfiles/common/parity/b.conf";

const LOCAL_A = "/home/user/.config/parity/a.conf";

const LOCAL_B = "/home/user/.config/parity/b.conf";

const LOCAL_DIR = "/home/user/.config/parity";

const MODE = 0o644;

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const LAST_SYNC = "/home/user/.local/state/sync-settings/last-sync";

const BACKUPS_FOLDER =
  "/home/user/.local/state/sync-settings/backups/20260101-120000-1";

const OLD_BYTES = new TextEncoder().encode("old\n");

const NEW_BYTES = new TextEncoder().encode("new\n");

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: { parity: { description: "Parity files" } },
  entries: [
    {
      file: "parity/a.conf",
      module: "parity",
      merge: "whole",
      localPath: "~/.config/parity/a.conf",
    },
  ],
};

function snapshotFor(
  repoBytes: Uint8Array,
  localBytes: Uint8Array | undefined,
): Snapshot {
  const localFiles = new Map<string, LocalEntry>();
  if (localBytes !== undefined) {
    localFiles.set(LOCAL_A, {
      kind: "file",
      path: LOCAL_A,
      bytes: localBytes,
      mode: MODE,
    });
  }
  return {
    config: CONFIG,
    os: "linux",
    home: HOME,
    cwd: HOME,
    repoFiles: new Map([[REPO_A, repoBytes]]),
    localFiles,
    localDirs: new Set([LOCAL_DIR]),
    values: {},
    env: {},
    only: [],
    force: true,
    head: HEAD,
    porcelain: "",
  };
}

/** Two files that both applied, with the sync point ready to be written. */
function twoFilePlan(): RunPlan {
  return {
    steps: [
      {
        label: REPO_A,
        line: 0,
        counted: true,
        actions: [
          {
            action: { kind: "backup", path: LOCAL_A, repoPath: REPO_A },
            failure: "cannot create backup",
          },
          {
            action: { kind: "writeLocal", path: LOCAL_A, bytes: NEW_BYTES },
            failure: "cannot write local file",
          },
        ],
      },
      {
        label: REPO_B,
        line: 1,
        counted: true,
        actions: [
          {
            action: { kind: "writeLocal", path: LOCAL_B, bytes: NEW_BYTES },
            failure: "cannot write local file",
          },
        ],
      },
    ],
    finish: [{ kind: "writeState", path: LAST_SYNC, text: `${HEAD}\n` }],
    lines: [formatLine("UPDATED", REPO_A), formatLine("CREATED", REPO_B)],
    summary: { kind: "import", onlyMatchedNothing: false, syncPoint: HEAD },
    code: 0,
  };
}

describe("renderRun", () => {
  test("renders the import planner's output unchanged when no step fails", () => {
    // Arrange
    const expected = renderRun(
      planImport(snapshotFor(NEW_BYTES, OLD_BYTES), []),
      NO_FAILURES,
    );
    const plan: RunPlan = {
      steps: [
        {
          label: REPO_A,
          line: 0,
          counted: true,
          actions: [
            {
              action: { kind: "backup", path: LOCAL_A, repoPath: REPO_A },
              failure: "cannot create backup",
            },
            {
              action: { kind: "writeLocal", path: LOCAL_A, bytes: NEW_BYTES },
              failure: "cannot write local file",
            },
          ],
        },
      ],
      finish: [{ kind: "writeState", path: LAST_SYNC, text: `${HEAD}\n` }],
      lines: expected.lines.slice(0, 1),
      summary: { kind: "import", onlyMatchedNothing: false, syncPoint: HEAD },
      code: 0,
    };

    // Act
    const rendered = renderRun(plan, NO_FAILURES);

    // Assert
    expect(rendered).toEqual({ lines: expected.lines, code: 0 });
  });

  test("renders the export planner's changed-file output unchanged", () => {
    // Arrange
    const expected = renderRun(
      planExport(snapshotFor(OLD_BYTES, NEW_BYTES)),
      NO_FAILURES,
    );
    const plan: RunPlan = {
      steps: [
        {
          label: REPO_A,
          line: 0,
          counted: true,
          actions: [
            {
              action: { kind: "writeRepo", path: REPO_A, bytes: NEW_BYTES },
              failure: "cannot copy to repo",
            },
            {
              action: { kind: "chmod", path: REPO_A, mode: MODE },
              failure: "cannot copy file mode",
            },
          ],
        },
      ],
      finish: [],
      lines: expected.lines.slice(0, 1),
      summary: { kind: "export", onlyMatchedNothing: false, skipped: 0 },
      code: 0,
    };

    // Act
    const rendered = renderRun(plan, NO_FAILURES);

    // Assert
    expect(rendered).toEqual({ lines: expected.lines, code: 0 });
  });

  test("renders the export planner's skipped-file note unchanged", () => {
    // Arrange
    const expected = renderRun(
      planExport(snapshotFor(OLD_BYTES, undefined)),
      NO_FAILURES,
    );
    const plan: RunPlan = {
      steps: [],
      finish: [],
      lines: expected.lines.slice(0, 1),
      summary: { kind: "export", onlyMatchedNothing: false, skipped: 1 },
      code: 0,
    };

    // Act
    const rendered = renderRun(plan, NO_FAILURES);

    // Assert
    expect(rendered).toEqual({ lines: expected.lines, code: 0 });
  });

  test("replaces a failed step's line with ERROR and lowers the count", () => {
    // Arrange
    const outcome: RunOutcome = {
      failed: new Map([[0, "cannot create backup"]]),
      warnings: new Map(),
    };

    // Act
    const rendered = renderRun(twoFilePlan(), outcome);

    // Assert
    expect(rendered.lines[0]).toBe(
      formatLine("ERROR", REPO_A, "cannot create backup"),
    );
    expect(rendered.lines).not.toContain(formatLine("UPDATED", REPO_A));
    expect(rendered.lines).toContain("  1 file(s) applied.");
  });

  test("drops the sync point line when a step fails", () => {
    // Arrange
    const outcome: RunOutcome = {
      failed: new Map([[0, "cannot create backup"]]),
      warnings: new Map(),
    };

    // Act
    const rendered = renderRun(twoFilePlan(), outcome);

    // Assert
    expect(
      rendered.lines.some((line) => line.startsWith("  Sync point :")),
    ).toBe(false);
  });

  test("prints a step's warning right before its line", () => {
    // Arrange
    const warning =
      "  WARNING: could not keep a dated backup of dotfiles/common/parity/a.conf.";
    const outcome: RunOutcome = {
      failed: new Map(),
      warnings: new Map([[0, [warning]]]),
    };

    // Act
    const rendered = renderRun(twoFilePlan(), outcome);

    // Assert
    expect(rendered.lines[0]).toBe(warning);
    expect(rendered.lines[1]).toBe(formatLine("UPDATED", REPO_A));
  });

  test("places the Backups folder between the applied count and the sync point", () => {
    // Arrange
    const outcome: RunOutcome = { ...NO_FAILURES, backups: BACKUPS_FOLDER };

    // Act
    const rendered = renderRun(twoFilePlan(), outcome);

    // Assert
    const applied = rendered.lines.indexOf("  2 file(s) applied.");
    expect(rendered.lines[applied + 1]).toBe("");
    expect(rendered.lines[applied + 2]).toBe(
      `  Backups    : ${BACKUPS_FOLDER}`,
    );
    expect(rendered.lines[applied + 3]).toBe("");
    expect(rendered.lines[applied + 4]).toBe(
      `  Sync point : ${HEAD.slice(0, 7)}`,
    );
  });
});
