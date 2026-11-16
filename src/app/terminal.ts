/** The run's terminal output: printed lines and the setup flow's io. A leaf
 * module, so `run.ts` and `export.ts` both use it without importing each other. */
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import type { SetupIo } from "../wizard/setup.ts";

/** Lines joined for printing, each ending in a newline; none prints nothing. */
export function writeLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The setup flow's terminal: text to stdout, answers from stdin. */
export interface SetupTerminal {
  readonly io: SetupIo;
  close(): void;
}

/**
 * `setup`'s io: text goes to stdout at once, so a question shows before its
 * answer is read; `readLine` pulls stdin lines on demand, `undefined` at end
 * of input.
 */
export function setupTerminal(): SetupTerminal {
  let reader: Interface | undefined;
  const queued: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  const push = (line: string): void => {
    const resolve = waiting.shift();
    if (resolve === undefined) {
      queued.push(line);
    } else {
      resolve(line);
    }
  };
  const end = (): void => {
    ended = true;
    for (const resolve of waiting.splice(0)) {
      resolve(undefined);
    }
  };
  return {
    io: {
      write: (text) => {
        process.stdout.write(text);
      },
      readLine: async () => {
        if (reader === undefined) {
          reader = createInterface({ input: process.stdin });
          reader.on("line", push);
          reader.on("close", end);
        }
        const line = queued.shift();
        if (line !== undefined) {
          return line;
        }
        if (ended) {
          return undefined;
        }
        return new Promise((resolve) => {
          waiting.push(resolve);
        });
      },
    },
    close: () => {
      reader?.close();
    },
  };
}
