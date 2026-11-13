import { describe, expect, test } from "bun:test";
import { checkRecord } from "./check.ts";
import type { MachineIdentity } from "./check.ts";
import type { MachineRecord } from "./record.ts";

const RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
  os: "linux",
  hostname: "wk1-laptop",
  domain: null,
  claude: "claude-deepseek",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const IDENTITY: MachineIdentity = {
  os: "linux",
  hostname: "wk1-laptop",
  domain: null,
};

const IF_LINE =
  "If this is a new machine, run: mksync setup --replace wk1-laptop";

const HOSTNAME_DIFFERENT =
  "the record says hostname wk1-laptop, this machine is wk1-new.";

function record(extra: Partial<MachineRecord> = {}): MachineRecord {
  return { ...RECORD, ...extra };
}

function identity(extra: Partial<MachineIdentity> = {}): MachineIdentity {
  return { ...IDENTITY, ...extra };
}

describe("checkRecord", () => {
  test("push with no difference prints nothing and goes on", () => {
    // Act
    const result = checkRecord(record(), identity(), "push");

    // Assert
    expect(result).toEqual({ lines: [], stop: false });
  });

  test("preview with no difference prints nothing and goes on", () => {
    expect(checkRecord(record(), identity(), "preview")).toEqual({
      lines: [],
      stop: false,
    });
  });

  test("pull with no difference prints nothing and goes on", () => {
    expect(checkRecord(record(), identity(), "pull")).toEqual({
      lines: [],
      stop: false,
    });
  });

  test("push stops on a moved hostname with the ERROR line and the If line", () => {
    // Act
    const result = checkRecord(
      record(),
      identity({ hostname: "wk1-new" }),
      "push",
    );

    // Assert
    expect(result).toEqual({
      lines: [`ERROR: ${HOSTNAME_DIFFERENT}`, IF_LINE],
      stop: true,
    });
  });

  test("preview warns on a moved hostname and goes on", () => {
    expect(
      checkRecord(record(), identity({ hostname: "wk1-new" }), "preview"),
    ).toEqual({
      lines: [`warning: ${HOSTNAME_DIFFERENT}`, IF_LINE],
      stop: false,
    });
  });

  test("pull warns on a moved hostname and goes on", () => {
    expect(
      checkRecord(record(), identity({ hostname: "wk1-new" }), "pull"),
    ).toEqual({
      lines: [`warning: ${HOSTNAME_DIFFERENT}`, IF_LINE],
      stop: false,
    });
  });

  test("a domain the record has and this machine lacks shows none", () => {
    // Arrange
    const withDomain = record({ domain: "corp.example.com" });

    // Act
    const result = checkRecord(withDomain, identity(), "push");

    // Assert
    expect(result).toEqual({
      lines: [
        "ERROR: the record says domain corp.example.com, this machine has none.",
        IF_LINE,
      ],
      stop: true,
    });
  });

  test("a domain this machine has and the record lacks shows none", () => {
    // Act
    const result = checkRecord(
      record(),
      identity({ domain: "corp.example.com" }),
      "push",
    );

    // Assert
    expect(result).toEqual({
      lines: [
        "ERROR: the record says domain none, this machine has corp.example.com.",
        IF_LINE,
      ],
      stop: true,
    });
  });

  test("push warns and goes on when only the os differs", () => {
    // Act
    const result = checkRecord(record(), identity({ os: "windows" }), "push");

    // Assert
    expect(result).toEqual({
      lines: [
        "warning: the record says os linux, this machine is windows.",
        IF_LINE,
      ],
      stop: false,
    });
  });

  test("push stops on a retired record", () => {
    expect(checkRecord(record({ retired: true }), identity(), "push")).toEqual({
      lines: ["ERROR: this machine is retired."],
      stop: true,
    });
  });

  test("preview warns on a retired record and goes on", () => {
    expect(
      checkRecord(record({ retired: true }), identity(), "preview"),
    ).toEqual({
      lines: ["warning: this machine is retired."],
      stop: false,
    });
  });

  test("pull says nothing about a retired record", () => {
    expect(checkRecord(record({ retired: true }), identity(), "pull")).toEqual({
      lines: [],
      stop: false,
    });
  });

  test("push stops on a pull-only record", () => {
    expect(checkRecord(record({ pullOnly: true }), identity(), "push")).toEqual(
      {
        lines: ["ERROR: this machine is pull-only (see mksync machine show)."],
        stop: true,
      },
    );
  });

  test("preview warns on a pull-only record and goes on", () => {
    expect(
      checkRecord(record({ pullOnly: true }), identity(), "preview"),
    ).toEqual({
      lines: ["warning: this machine is pull-only (see mksync machine show)."],
      stop: false,
    });
  });

  test("retired beats pull-only on push", () => {
    // Arrange
    const both = record({ retired: true, pullOnly: true });

    // Act
    const result = checkRecord(both, identity(), "push");

    // Assert
    expect(result).toEqual({
      lines: ["ERROR: this machine is retired."],
      stop: true,
    });
  });

  test("preview prints both refusals as warnings in order", () => {
    // Arrange
    const both = record({ retired: true, pullOnly: true });

    // Act
    const result = checkRecord(both, identity(), "preview");

    // Assert
    expect(result.lines).toEqual([
      "warning: this machine is retired.",
      "warning: this machine is pull-only (see mksync machine show).",
    ]);
  });

  test("push with the os and the hostname moved prints both ERROR lines", () => {
    // Act
    const result = checkRecord(
      record(),
      identity({ os: "windows", hostname: "wk1-new" }),
      "push",
    );

    // Assert
    expect(result).toEqual({
      lines: [
        "ERROR: the record says os linux, this machine is windows.",
        `ERROR: ${HOSTNAME_DIFFERENT}`,
        IF_LINE,
      ],
      stop: true,
    });
  });
});
