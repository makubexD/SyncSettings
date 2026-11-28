import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELP_TEXT, helpText } from "./help.ts";
import type { HelpTopic } from "./help.ts";

const CONTRACT = join(import.meta.dir, "..", "..", "docs", "sync-contract.md");

const MAX_COLUMNS = 80;

/** The contract's "Help" subsection, up to the next section heading. */
function helpSection(): string {
  const text = readFileSync(CONTRACT, "utf8");
  const start = text.indexOf("\n#### Help\n");
  if (start < 0) {
    throw new Error("the contract has no #### Help subsection");
  }
  const rest = text.slice(start + 1);
  const end = rest.search(/\n#{2,4} /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** Each `text` block in the Help subsection, keyed by its topic: the top level
 * under "The top level (…):", every other under "`mksync <words> --help`:". */
function contractTexts(): Map<string, string> {
  const texts = new Map<string, string>();
  const block = /^(.+):\n\n```text\n([\s\S]*?)```\n/gm;
  for (const match of helpSection().matchAll(block)) {
    const heading = match[1] ?? "";
    const body = match[2] ?? "";
    const command = /^`mksync (.+) --help`$/.exec(heading);
    let topic: string;
    if (heading.startsWith("The top level")) {
      topic = "top";
    } else if (command?.[1] !== undefined) {
      topic = command[1];
    } else {
      throw new Error(`a text block under an unknown heading: ${heading}`);
    }
    if (texts.has(topic)) {
      throw new Error(`the contract has two blocks for ${topic}`);
    }
    texts.set(topic, body);
  }
  return texts;
}

const TEXTS = contractTexts();
const TOPICS = Object.keys(HELP_TEXT) as HelpTopic[];

describe("help texts", () => {
  test("the topics are exactly the contract's", () => {
    expect([...TOPICS].sort() as string[]).toEqual([...TEXTS.keys()].sort());
    expect(TOPICS.length).toBe(23);
  });

  for (const topic of TOPICS) {
    describe(topic, () => {
      test("equals the contract's block byte for byte", () => {
        expect(helpText(topic)).toBe(TEXTS.get(topic) ?? "<missing>");
      });

      test("fits in 80 columns", () => {
        for (const line of helpText(topic).split("\n")) {
          expect(line.length).toBeLessThanOrEqual(MAX_COLUMNS);
        }
      });

      test("ends with exactly one newline", () => {
        const text = helpText(topic);
        expect(text.endsWith("\n")).toBe(true);
        expect(text.endsWith("\n\n")).toBe(false);
      });
    });
  }
});
