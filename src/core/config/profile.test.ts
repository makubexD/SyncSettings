import { describe, expect, test } from "bun:test";
import type { ConfigV2 } from "./types.ts";
import { parseProfile } from "./profile.ts";
import type { Profile } from "./profile.ts";

const NAME = "work-1";

const MODULES: ConfigV2["modules"] = {
  git: { description: "Git settings" },
  shell: { description: "Shell settings" },
  gnome: { description: "GNOME desktop", os: ["linux"] },
};

const CONFIG: ConfigV2 = {
  schemaVersion: 2,
  modules: MODULES,
  entries: [],
};

const FULL_FILE = {
  modules: ["git", "shell"],
  values: {
    "<YOUR_EMAIL>": "jane@example.com",
    "<YOUR_GH_ORG>": "example-org",
  },
  destinations: {
    "claude settings.json: permissions.allow": "profile",
    "vscode settings.json: window.zoomLevel": "machine",
  },
  retired: true,
};

const FULL_PROFILE: Profile = { name: NAME, ...FULL_FILE };

function expectFailureText(
  text: string,
  message: string,
): void {
  // Act
  const result = parseProfile(NAME, text, CONFIG);

  // Assert
  expect(result).toEqual({ ok: false, error: { message, code: 2 } });
}

describe("parseProfile", () => {
  test("reads a full profile", () => {
    // Act
    const result = parseProfile(NAME, JSON.stringify(FULL_FILE), CONFIG);

    // Assert
    expect(result).toEqual({ ok: true, value: FULL_PROFILE });
  });

  test("defaults every field on an empty object", () => {
    // Act
    const result = parseProfile(NAME, "{}", CONFIG);

    // Assert
    expect(result).toEqual({
      ok: true,
      value: {
        name: NAME,
        modules: [],
        values: {},
        destinations: {},
        retired: false,
      },
    });
  });

  test("refuses text that is not valid JSON", () => {
    expectFailureText("{", `ERROR: profile ${NAME}: not valid JSON.`);
  });

  test("refuses JSON that is not an object", () => {
    expectFailureText("[1]", `ERROR: profile ${NAME}: not valid JSON.`);
  });

  test("refuses an unknown field", () => {
    expectFailureText(
      JSON.stringify({ modules: ["git"], color: "blue" }),
      `ERROR: profile ${NAME}: unknown field color.`,
    );
  });

  test("refuses a module config v2 doesn't know", () => {
    expectFailureText(
      JSON.stringify({ modules: ["git", "nope"] }),
      `ERROR: profile ${NAME}: unknown module nope.`,
    );
  });

  test("refuses modules that aren't an array of strings", () => {
    expectFailureText(
      JSON.stringify({ modules: ["git", 1] }),
      `ERROR: profile ${NAME}: modules has the wrong type.`,
    );
    expectFailureText(
      JSON.stringify({ modules: "git" }),
      `ERROR: profile ${NAME}: modules has the wrong type.`,
    );
  });

  test("refuses values that aren't an object of strings", () => {
    expectFailureText(
      JSON.stringify({ values: { "<A>": 1 } }),
      `ERROR: profile ${NAME}: values has the wrong type.`,
    );
    expectFailureText(
      JSON.stringify({ values: [] }),
      `ERROR: profile ${NAME}: values has the wrong type.`,
    );
  });

  test("refuses destinations that aren't an object", () => {
    expectFailureText(
      JSON.stringify({ destinations: [] }),
      `ERROR: profile ${NAME}: destinations has the wrong type.`,
    );
  });

  test.each(["base", "os", "profile", "machine"])(
    "accepts destination %s",
    (slot) => {
      // Act
      const result = parseProfile(
        NAME,
        JSON.stringify({ destinations: { "settings.json: a": slot } }),
        CONFIG,
      );

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.destinations).toEqual({
          "settings.json: a": slot,
        });
      }
    },
  );

  test("refuses a destination that isn't a layer", () => {
    expectFailureText(
      JSON.stringify({ destinations: { "settings.json: a": "repo" } }),
      `ERROR: profile ${NAME}: destination settings.json: a is not a layer.`,
    );
  });

  test("refuses a destination that isn't a string", () => {
    expectFailureText(
      JSON.stringify({ destinations: { "settings.json: a": 1 } }),
      `ERROR: profile ${NAME}: destination settings.json: a is not a layer.`,
    );
    expectFailureText(
      JSON.stringify({ destinations: { "settings.json: a": null } }),
      `ERROR: profile ${NAME}: destination settings.json: a is not a layer.`,
    );
  });

  test("refuses a retired that isn't a boolean", () => {
    expectFailureText(
      JSON.stringify({ retired: "yes" }),
      `ERROR: profile ${NAME}: retired has the wrong type.`,
    );
  });

  test("keeps a __proto__ key as plain data", () => {
    // Act
    const result = parseProfile(
      NAME,
      '{"values": {"__proto__": "plain"}}',
      CONFIG,
    );

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.value.values)).toBe(
        Object.prototype,
      );
      expect(Object.entries(result.value.values)).toEqual([
        ["__proto__", "plain"],
      ]);
    }
  });
});
