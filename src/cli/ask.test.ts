import { describe, expect, test } from "bun:test";
import { newSettingChoices } from "../core/plan/newsettings.ts";
import type { NewSettingQuestion } from "../core/plan/newsettings.ts";
import { askNewSettings } from "./ask.ts";

/** The work profile's question, which a record always has. */
function workQuestion(): NewSettingQuestion {
  const question = newSettingChoices({ profile: "work-1" }, "linux");
  if (question === undefined) {
    throw new Error("a record always has a question");
  }
  return question;
}

const QUESTION = workQuestion();

const INDENT = "     ";

const SETTING = '  2  +  parity  settings.json  delta[]: "new item"';

const SECOND_SETTING = "  3  +  parity  settings.json  newKey: true";

const PROMPT =
  "Where does it go? 1) all machines  2) Linux machines  3) profile work-1  4) this machine [3] ";

/** A scripted terminal: answers in order, then end of input. */
async function ask(
  answers: readonly string[],
  settings: readonly string[] = [SETTING],
): Promise<{ choices: readonly number[]; output: string }> {
  let output = "";
  const queue = [...answers];
  const choices = await askNewSettings(
    {
      write: (text) => {
        output += text;
      },
      readLine: async () => queue.shift(),
    },
    { settings, indent: INDENT },
    QUESTION,
  );
  return { choices: choices.map((choice) => choice.number), output };
}

describe("askNewSettings", () => {
  test("should take the answer a number names", async () => {
    // Arrange / Act
    const { choices, output } = await ask(["4"]);

    // Assert
    expect(choices).toEqual([4]);
    expect(output).toBe(`${SETTING}\n${INDENT}${PROMPT}`);
  });

  test("should take the suggestion for an empty answer", async () => {
    // Arrange / Act
    const { choices } = await ask([""]);

    // Assert
    expect(choices).toEqual([3]);
  });

  test("should take the suggestion at end of input", async () => {
    // Arrange / Act
    const { choices } = await ask([]);

    // Assert
    expect(choices).toEqual([3]);
  });

  test("should print Pick 1 to 4. and ask again after a bad answer", async () => {
    // Arrange / Act
    const { choices, output } = await ask(["9", "2"]);

    // Assert
    expect(choices).toEqual([2]);
    expect(output).toBe(
      `${SETTING}\n${INDENT}${PROMPT}Pick 1 to 4.\n${INDENT}${PROMPT}`,
    );
  });

  test("should return one choice per setting", async () => {
    // Arrange / Act
    const { choices, output } = await ask(
      ["1", "4"],
      [SETTING, SECOND_SETTING],
    );

    // Assert
    expect(choices).toEqual([1, 4]);
    expect(output).toBe(
      `${SETTING}\n${INDENT}${PROMPT}${SECOND_SETTING}\n${INDENT}${PROMPT}`,
    );
  });
});
