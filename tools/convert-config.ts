// Dev-only: converts sync-config.json to v2 and prints it. Never compiled into the program.
import { convertV1 } from "../src/core/config/convert.ts";
import { parseV1 } from "../src/core/config/v1.ts";

const SOURCE = "sync-config.json";
const INDENT = 2;

const parsed = parseV1(await Bun.file(SOURCE).text());
if (!parsed.ok) {
  console.error(parsed.error.message);
  process.exit(parsed.error.code);
}
const converted = convertV1(parsed.value);
if (!converted.ok) {
  console.error(converted.error.message);
  process.exit(converted.error.code);
}
process.stdout.write(`${JSON.stringify(converted.value, null, INDENT)}\n`);
