import { describe, expect, test } from "bun:test";
import type { MachineRecord, ReplacedMachine } from "./record.ts";
import { replaceRecord } from "./replace.ts";
import type { ReplaceScan } from "./replace.ts";

const DATE = "2026-11-13";

const OLD_RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
  os: "windows",
  hostname: "wk1-laptop",
  domain: "corp.example.com",
  claude: "claude",
  pullOnly: true,
  modules: { add: ["git"], remove: ["other"] },
  values: { "<HOME>": "C:\\Users\\user" },
  replaced: [],
  retired: false,
};

const PRIOR_REPLACED: ReplacedMachine = {
  hostname: "wk1-older",
  domain: null,
  date: "2026-01-02",
};

const MOVED_SCAN: ReplaceScan = {
  os: "linux",
  hostname: "wk1-new",
  domain: "corp.example.com",
};

describe("replaceRecord", () => {
  test("keeps the old record's own fields", () => {
    // Act
    const record = replaceRecord(OLD_RECORD, MOVED_SCAN, DATE);

    // Assert
    expect(record.name).toBe(OLD_RECORD.name);
    expect(record.profile).toBe(OLD_RECORD.profile);
    expect(record.claude).toBe(OLD_RECORD.claude);
    expect(record.pullOnly).toBe(OLD_RECORD.pullOnly);
    expect(record.modules).toEqual(OLD_RECORD.modules);
    expect(record.values).toEqual(OLD_RECORD.values);
    expect(record.retired).toBe(OLD_RECORD.retired);
  });

  test("takes the os, hostname and domain from the scan", () => {
    // Act
    const record = replaceRecord(OLD_RECORD, MOVED_SCAN, DATE);

    // Assert
    expect(record.os).toBe(MOVED_SCAN.os);
    expect(record.hostname).toBe(MOVED_SCAN.hostname);
    expect(record.domain).toBe(MOVED_SCAN.domain);
  });

  test("appends the old pair with the date on a new hostname", () => {
    // Act
    const record = replaceRecord(OLD_RECORD, MOVED_SCAN, DATE);

    // Assert
    expect(record.replaced).toEqual([
      {
        hostname: OLD_RECORD.hostname,
        domain: OLD_RECORD.domain,
        date: DATE,
      },
    ]);
  });

  test("appends the old pair on a changed domain alone", () => {
    // Arrange
    const scan: ReplaceScan = {
      ...MOVED_SCAN,
      hostname: OLD_RECORD.hostname,
      domain: "other.example.com",
    };

    // Act
    const record = replaceRecord(OLD_RECORD, scan, DATE);

    // Assert
    expect(record.replaced).toEqual([
      {
        hostname: OLD_RECORD.hostname,
        domain: OLD_RECORD.domain,
        date: DATE,
      },
    ]);
  });

  test("adds no entry when the hostname and domain are unchanged", () => {
    // Arrange
    const scan: ReplaceScan = {
      os: OLD_RECORD.os,
      hostname: OLD_RECORD.hostname,
      domain: OLD_RECORD.domain,
    };

    // Act
    const record = replaceRecord(OLD_RECORD, scan, DATE);

    // Assert
    expect(record.replaced).toEqual([]);
  });

  test("keeps earlier replaced entries first", () => {
    // Arrange
    const old: MachineRecord = {
      ...OLD_RECORD,
      replaced: [PRIOR_REPLACED],
    };

    // Act
    const record = replaceRecord(old, MOVED_SCAN, DATE);

    // Assert
    expect(record.replaced).toEqual([
      PRIOR_REPLACED,
      {
        hostname: OLD_RECORD.hostname,
        domain: OLD_RECORD.domain,
        date: DATE,
      },
    ]);
  });

  test("does not mutate the input record", () => {
    // Arrange
    const old: MachineRecord = {
      ...OLD_RECORD,
      replaced: [PRIOR_REPLACED],
    };
    const before = structuredClone(old);

    // Act
    replaceRecord(old, MOVED_SCAN, DATE);

    // Assert
    expect(old).toEqual(before);
  });
});
