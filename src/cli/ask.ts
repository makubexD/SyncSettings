import type {
  NewSettingChoice,
  NewSettingQuestion,
} from "../core/plan/newsettings.ts";
import type { SetupIo } from "../wizard/setup.ts";

/** The settings section a question sits under: one line per new setting and
 * the indent that reaches its kind column. */
export interface SettingsBlock {
  readonly settings: readonly string[];
  readonly indent: string;
}

/** The contract's line for an answer that isn't one of the choices. */
const PICK_ONE = "Pick 1 to 4.\n";

/** The question as `export` prints it, one space after and no newline
 * (contract "New settings (program only)"). */
function promptOf(question: NewSettingQuestion): string {
  const picks = question.choices
    .map((choice) => `${choice.number}) ${choice.words}`)
    .join("  ");
  return `Where does it go? ${picks} [${question.suggestion.number}] `;
}

/** The choice an answer names, or `undefined` when it names none. */
function choiceOf(
  question: NewSettingQuestion,
  answer: string,
): NewSettingChoice | undefined {
  return question.choices.find(
    (choice) => String(choice.number) === answer,
  );
}

/**
 * Ask one setting's question until it gets an answer: an empty answer or end of
 * input takes the suggestion, a number picks its choice, and anything else
 * prints `Pick 1 to 4.` and asks again.
 */
async function askOne(
  io: SetupIo,
  indent: string,
  prompt: string,
  question: NewSettingQuestion,
): Promise<NewSettingChoice> {
  for (;;) {
    io.write(`${indent}${prompt}`);
    const answer = (await io.readLine())?.trim() ?? "";
    if (answer === "") {
      return question.suggestion;
    }
    const choice = choiceOf(question, answer);
    if (choice !== undefined) {
      return choice;
    }
    io.write(PICK_ONE);
  }
}

/**
 * Contract "New settings (program only)", Asking: print each new setting's
 * numbered line, then its question, and read one choice per setting. The
 * terminal's writes are not buffered, so the question shows before its answer
 * is read.
 */
export async function askNewSettings(
  io: SetupIo,
  grouped: SettingsBlock,
  question: NewSettingQuestion,
): Promise<readonly NewSettingChoice[]> {
  const prompt = promptOf(question);
  const choices: NewSettingChoice[] = [];
  for (const line of grouped.settings) {
    io.write(`${line}\n`);
    choices.push(await askOne(io, grouped.indent, prompt, question));
  }
  return choices;
}
