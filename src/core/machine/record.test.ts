import { describe, expect, test } from "bun:test";
import type { ConfigV2 } from "../config/types.ts";
import { parseRecord, recordMessage, recordText } from "./record.ts";
import type { MachineRecord } from "./record.ts";

const MODULES: ConfigV2["modules"] = {
  git: { description: "Git settings" },
  shell: { description: "Shell settings" },
  claude: { description: "Claude config" },
  other: { description: "Other settings" },
};

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: MODULES,
  entries: [],
};

const FULL_RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
  os: "windows",
  hostname: "wk1-laptop",
  domain: "corp.example.com",
  claude: "claude",
  pullOnly: false,
  modules: { add: ["git"], remove: ["other"] },
  values: { "<HOME>": "C:\\Users\\user" },
  replaced: [
    {
      hostname: "wk1-new",
      domain: "corp.example.com",
      date: "2026-01-02",
    },
  ],
  retired: false,
};

const FULL_TEXT = `{
  "name": "wk1-laptop",
  "profile": "work-1",
  "os": "windows",
  "hostname": "wk1-laptop",
  "domain": "corp.example.com",
  "claude": "claude",
  "pullOnly": false,
  "modules": {
    "add": [
      "git"
    ],
    "remove": [
      "other"
    ]
  },
  "values": {
    "<HOME>": "C:\\\\Users\\\\user"
  },
  "replaced": [
    {
      "hostname": "wk1-new",
      "domain": "corp.example.com",
      "date": "2026-01-02"
    }
  ],
  "retired": false
}
`;

const EMPTY_RECORD: MachineRecord = {
  name: "wk1-laptop",
  profile: "work-1",
  os: "linux",
  hostname: "wk1-laptop",
  domain: null,
  claude: "none",
  pullOnly: false,
  modules: { add: [], remove: [] },
  values: {},
  replaced: [],
  retired: false,
};

const EMPTY_TEXT = `{
  "name": "wk1-laptop",
  "profile": "work-1",
  "os": "linux",
  "hostname": "wk1-laptop",
  "domain": null,
  "claude": "none",
  "pullOnly": false,
  "modules": {
    "add": [],
    "remove": []
  },
  "values": {},
  "replaced": [],
  "retired": false
}
`;

const MISSING_FIELDS: readonly string[] = [
  "name",
  "profile",
  "os",
  "hostname",
  "domain",
  "claude",
  "pullOnly",
  "modules",
  "values",
  "replaced",
  "retired",
];

function expectTextFailure(text: string, reason: string): void {
  // Act
  const result = parseRecord(text, CONFIG);

  // Assert
  expect(result).toEqual({ ok: false, error: reason });
}

function expectFailure(record: unknown, reason: string): void {
  expectTextFailure(JSON.stringify(record), reason);
}

describe("parseRecord", () => {
  test("reads a full record", () => {
    // Act
    const result = parseRecord(FULL_TEXT, CONFIG);

    // Assert
    expect(result).toEqual({ ok: true, value: FULL_RECORD });
  });

  test("refuses text that is not valid JSON", () => {
    expectTextFailure("{", "not valid JSON");
  });

  test("refuses JSON that is not an object", () => {
    expectTextFailure("[1]", "not valid JSON");
  });

  test("refuses an unknown field", () => {
    expectFailure({ ...FULL_RECORD, color: "blue" }, "unknown field color");
  });

  test.each(MISSING_FIELDS)("refuses a record with no %s", (field) => {
    // Arrange
    const record: Record<string, unknown> = { ...FULL_RECORD };
    delete record[field];

    // Act
    const result = parseRecord(JSON.stringify(record), CONFIG);

    // Assert
    expect(result).toEqual({ ok: false, error: `missing field ${field}` });
  });

  test.each([
    ["name", 1, "name has the wrong type"],
    ["profile", 1, "profile has the wrong type"],
    ["os", 1, "os has the wrong type"],
    ["hostname", 1, "hostname has the wrong type"],
    ["domain", 1, "domain has the wrong type"],
    ["claude", 1, "claude has the wrong type"],
    ["pullOnly", "no", "pullOnly has the wrong type"],
    ["modules", [], "modules has the wrong type"],
    ["values", [], "values has the wrong type"],
    ["replaced", {}, "replaced has the wrong type"],
    ["retired", "no", "retired has the wrong type"],
  ])("refuses %s of the wrong type", (field, value, reason) => {
    expectFailure({ ...FULL_RECORD, [field]: value }, reason);
  });

  test("refuses a name that isn't lowercase letters, digits and -", () => {
    expectFailure(
      { ...FULL_RECORD, name: "Wk1-Laptop" },
      "name must be lowercase letters, digits and -; this is Wk1-Laptop",
    );
  });

  test("refuses a profile that isn't lowercase letters, digits and -", () => {
    expectFailure(
      { ...FULL_RECORD, profile: "Work 1" },
      "profile must be lowercase letters, digits and -; this is Work 1",
    );
  });

  test("refuses a name another layer uses", () => {
    expectFailure(
      { ...FULL_RECORD, name: "base" },
      "name can't be base: it names another layer",
    );
  });

  test("refuses a profile another layer uses", () => {
    expectFailure(
      { ...FULL_RECORD, profile: "linux" },
      "profile can't be linux: it names another layer",
    );
  });

  test("refuses a name equal to the profile", () => {
    expectFailure({ ...FULL_RECORD, name: "work-1" }, "name can't be work-1");
  });

  test("refuses an os outside linux, macos and windows", () => {
    expectFailure({ ...FULL_RECORD, os: "beos" }, "os can't be beos");
  });

  test("refuses a claude outside its three modes", () => {
    expectFailure(
      { ...FULL_RECORD, claude: "claude-worker" },
      "claude can't be claude-worker",
    );
  });

  test("accepts every os and claude mode", () => {
    // Act
    const results = [
      parseRecord(
        JSON.stringify({ ...FULL_RECORD, os: "linux", claude: "none" }),
        CONFIG,
      ),
      parseRecord(
        JSON.stringify({
          ...FULL_RECORD,
          os: "macos",
          claude: "claude-deepseek",
        }),
        CONFIG,
      ),
    ];

    // Assert
    expect(results.every((result) => result.ok)).toBe(true);
  });

  test("refuses modules that aren't an object", () => {
    expectFailure(
      { ...FULL_RECORD, modules: [] },
      "modules has the wrong type",
    );
  });

  test("refuses a module list that isn't a list of strings", () => {
    expectFailure(
      { ...FULL_RECORD, modules: { add: "git", remove: [] } },
      "modules has the wrong type",
    );
    expectFailure(
      { ...FULL_RECORD, modules: { add: [], remove: [1] } },
      "modules has the wrong type",
    );
  });

  test("refuses modules with no add or remove", () => {
    expectFailure(
      { ...FULL_RECORD, modules: { add: [] } },
      "missing field remove",
    );
    expectFailure(
      { ...FULL_RECORD, modules: { remove: [] } },
      "missing field add",
    );
  });

  test("refuses an unknown field inside modules", () => {
    expectFailure(
      { ...FULL_RECORD, modules: { add: [], remove: [], keep: [] } },
      "unknown field keep",
    );
  });

  test("refuses a module config v2 doesn't know", () => {
    expectFailure(
      { ...FULL_RECORD, modules: { add: ["git", "nope"], remove: [] } },
      "unknown module nope",
    );
    expectFailure(
      { ...FULL_RECORD, modules: { add: [], remove: ["nope"] } },
      "unknown module nope",
    );
  });

  test("refuses values that aren't an object of strings", () => {
    expectFailure(
      { ...FULL_RECORD, values: { "<HOME>": 1 } },
      "values has the wrong type",
    );
    expectFailure({ ...FULL_RECORD, values: [] }, "values has the wrong type");
  });

  test.each([
    ["a non-list", "no"],
    ["a non-object item", [1]],
    ["an item with no date", [{ hostname: "wk1-new", domain: null }]],
    [
      "an item with an extra key",
      [
        {
          hostname: "wk1-new",
          domain: null,
          date: "2026-01-02",
          extra: 1,
        },
      ],
    ],
    [
      "an item with a hostname that isn't a string",
      [{ hostname: 1, domain: null, date: "2026-01-02" }],
    ],
    [
      "an item with a domain that isn't a string or null",
      [{ hostname: "wk1-new", domain: 1, date: "2026-01-02" }],
    ],
    [
      "an item whose date isn't YYYY-MM-DD",
      [{ hostname: "wk1-new", domain: null, date: "2026-1-2" }],
    ],
  ])("refuses replaced with %s", (_label, replaced) => {
    expectFailure({ ...FULL_RECORD, replaced }, "replaced has the wrong type");
  });

  test("accepts a replaced domain of null", () => {
    // Act
    const result = parseRecord(
      JSON.stringify({
        ...FULL_RECORD,
        replaced: [{ hostname: "wk1-new", domain: null, date: "2026-01-02" }],
      }),
      CONFIG,
    );

    // Assert
    expect(result.ok).toBe(true);
  });
});

describe("recordText", () => {
  test("writes the record in the contract's key order and layout", () => {
    // Act
    const text = recordText(FULL_RECORD);

    // Assert
    expect(text).toBe(FULL_TEXT);
  });

  test("writes empty modules and values as [] and {}", () => {
    // Act
    const text = recordText(EMPTY_RECORD);

    // Assert
    expect(text).toBe(EMPTY_TEXT);
  });

  test("round trips a canonical record byte-exact", () => {
    // Act
    const parsed = parseRecord(FULL_TEXT, CONFIG);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    // Assert
    expect(recordText(parsed.value)).toBe(FULL_TEXT);
  });
});

describe("recordMessage", () => {
  test("puts a reason on the contract's ERROR line", () => {
    // Act
    const message = recordMessage("unknown field color");

    // Assert
    expect(message).toBe(
      "ERROR: machine record (machine.json in the state folder): unknown field color.",
    );
  });
});
