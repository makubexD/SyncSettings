// Dev-only: checks that sync-config.json and sync-config.v2.json stay in step. Never compiled into the program.
import { checkV1V2 } from "../src/core/config/check.ts";
import { parseV1 } from "../src/core/config/v1.ts";
import { parseV2 } from "../src/core/config/v2.ts";

const V1_SOURCE = "sync-config.json";

const V2_SOURCE = "sync-config.v2.json";

const v1 = parseV1(await Bun.file(V1_SOURCE).text());
if (!v1.ok) {
  console.error(v1.error.message);
  process.exit(v1.error.code);
}

const v2 = parseV2(await Bun.file(V2_SOURCE).text());
if (!v2.ok) {
  console.error(v2.error.message);
  process.exit(v2.error.code);
}

const lines = checkV1V2(v1.value, v2.value);
for (const line of lines) {
  console.error(line);
}
if (lines.length > 0) {
  process.exit(1);
}
process.stdout.write("config v1 and v2 in step\n");
