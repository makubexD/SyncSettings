import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import { renderProfileShow } from "./profile-show.ts";

const ORG_VALUE = "hidden-org-value";
const EMAIL_VALUE = "hidden-email-value";

const PROFILE: Profile = {
  name: "work1",
  label: "job 1 laptop",
  modules: ["work-base", "git", "shell", "vscode", "claude"],
  values: { "<WORK_ORG>": ORG_VALUE, "<WORK_EMAIL>": EMAIL_VALUE },
  destinations: {},
  retired: false,
};

const LAYER_FILES = ["claude/settings.json", "vscode/settings.json"];

function profileWith(overrides: Partial<Profile>): Profile {
  return { ...PROFILE, ...overrides };
}

describe("renderProfileShow", () => {
  test("should print the contract's five lines for a profile with a label", () => {
    // Act
    const lines = renderProfileShow(PROFILE, LAYER_FILES);

    // Assert
    expect(lines).toEqual([
      "profile   work1",
      "label     job 1 laptop",
      "modules   work-base, git, shell, vscode, claude",
      "values    <WORK_EMAIL>, <WORK_ORG>",
      "layer     2 file(s): claude/settings.json, vscode/settings.json",
    ]);
  });

  test("should leave out the label line when the profile has none", () => {
    // Arrange
    const { label: _label, ...unlabelled } = PROFILE;

    // Act
    const lines = renderProfileShow(unlabelled, LAYER_FILES);

    // Assert
    expect(lines.some((text) => text.startsWith("label"))).toBe(false);
  });

  test("should add retired yes last for a retired profile", () => {
    // Act
    const lines = renderProfileShow(
      profileWith({ retired: true }),
      LAYER_FILES,
    );

    // Assert
    expect(lines.at(-1)).toBe("retired   yes");
  });

  test("should print none when the profile has no values", () => {
    // Act
    const lines = renderProfileShow(profileWith({ values: {} }), LAYER_FILES);

    // Assert
    expect(lines).toContain("values    none");
  });

  test("should print none when the profile has no modules", () => {
    // Act
    const lines = renderProfileShow(profileWith({ modules: [] }), LAYER_FILES);

    // Assert
    expect(lines).toContain("modules   none");
  });

  test("should print 0 file(s) when the layer holds no files", () => {
    // Act
    const lines = renderProfileShow(PROFILE, []);

    // Assert
    expect(lines).toContain("layer     0 file(s)");
  });

  test("should sort the value keys by code unit", () => {
    // Arrange
    const profile = profileWith({ values: { "<a>": "1", "<B>": "2" } });

    // Act
    const lines = renderProfileShow(profile, []);

    // Assert
    expect(lines).toContain("values    <B>, <a>");
  });

  test("should never print a value", () => {
    // Act
    const text = renderProfileShow(PROFILE, LAYER_FILES).join("\n");

    // Assert
    expect(text).not.toContain(ORG_VALUE);
    expect(text).not.toContain(EMAIL_VALUE);
  });
});
