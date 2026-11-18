// Dev-only: converts every shared case's v1 config to configV2 with the
// program's own conversion. Deleted in step 26; never compiled into the program.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertV1 } from "../src/core/config/convert.ts";
import { parseV1 } from "../src/core/config/v1.ts";

const CASES = join(import.meta.dir, "..", "tests", "parity", "cases");
const INDENT = 2;
const VERSION_RE = /\bversion\b/i;
const V1_FIELD_RE = /\brepoPath\b|\bplatform\b/i;
const CONFIG_PARSE_RE = /sync-config\.json:/i;

// The runner refuses a configV2 case whose env sets anything else.
const V2_ENV_KEYS: ReadonlySet<string> = new Set([
  "SYNC_PROFILE",
  "SYNC_MACHINE",
  "SYNC_HOSTNAME",
  "SYNC_DOMAIN",
  "SYNC_TOOLS",
  "MKSYNC_VISIBILITY",
  "SYNC_NOW",
  "SYNC_LOAD",
  "SYNC_MEM",
  "SYNC_GIT",
  "CONTEXT_CLEAR_AT",
  "CTX_WINDOW_DIR",
  "SYNC_OS_RELEASE",
]);

const EXPECTED_STDERR_FILES: ReadonlySet<string> = new Set(["output.txt", "lines.txt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function caseNames(): readonly string[] {
  return readdirSync(CASES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readCase(name: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(join(CASES, name, "case.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

// The runner keeps stderr apart only for a command that asks for it, so that is
// the only expected text this scan can call stderr.
function expectsStderr(caseJson: Record<string, unknown>): boolean {
  const commands = caseJson.commands;
  return (
    Array.isArray(commands) &&
    commands.some((command) => isRecord(command) && command.stderr === true)
  );
}

function expectedStderr(name: string): string {
  const caseDir = join(CASES, name);
  const parts: string[] = [];
  for (const entry of readdirSync(caseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !(entry.name === "expect" || entry.name.startsWith("expect."))) {
      continue;
    }
    for (const file of readdirSync(join(caseDir, entry.name), { withFileTypes: true })) {
      if (file.isFile() && EXPECTED_STDERR_FILES.has(file.name)) {
        parts.push(readFileSync(join(caseDir, entry.name, file.name), "utf8"));
      }
    }
  }
  return parts.join("\n");
}

function namesV1(description: string, stderr: string): boolean {
  return (
    VERSION_RE.test(description) ||
    V1_FIELD_RE.test(description) ||
    VERSION_RE.test(stderr) ||
    V1_FIELD_RE.test(stderr) ||
    CONFIG_PARSE_RE.test(stderr)
  );
}

function refusedAsV2(caseJson: Record<string, unknown>): boolean {
  if (!isRecord(caseJson.env)) {
    return false;
  }
  return Object.keys(caseJson.env).some((key) => !V2_ENV_KEYS.has(key));
}

function indent(value: string): string {
  return value.split("\n").join("\n  ");
}

// The converted value must sit in the file exactly as JSON.stringify lays it
// out; report the existing cases that keep a hand-formatted array instead.
function configV2FormattingMismatches(): readonly string[] {
  const mismatched: string[] = [];
  for (const name of caseNames()) {
    const caseJson = readCase(name);
    if (caseJson === undefined || !("configV2" in caseJson)) {
      continue;
    }
    const text = readFileSync(join(CASES, name, "case.json"), "utf8");
    const embedded = indent(JSON.stringify(caseJson.configV2, null, INDENT));
    if (!text.includes(`"configV2": ${embedded}`)) {
      mismatched.push(name);
    }
  }
  return mismatched;
}

const mismatched = configV2FormattingMismatches();
if (mismatched.length > 0) {
  console.error(
    `warning: ${mismatched.length} existing configV2 cases are not formatted as JSON.stringify(output, null, 2): ${mismatched.join(", ")}`,
  );
}

let converted = 0;
const v1Only: string[] = [];
for (const name of caseNames()) {
  const caseJson = readCase(name);
  if (caseJson === undefined || !("config" in caseJson)) {
    continue;
  }
  if ("configV2" in caseJson || refusedAsV2(caseJson)) {
    v1Only.push(name);
    continue;
  }
  const parsed = parseV1(JSON.stringify(caseJson.config));
  if (!parsed.ok) {
    v1Only.push(name);
    continue;
  }
  const convertedV2 = convertV1(parsed.value);
  if (!convertedV2.ok) {
    v1Only.push(name);
    continue;
  }
  const description = typeof caseJson.description === "string" ? caseJson.description : "";
  if (namesV1(description, expectsStderr(caseJson) ? expectedStderr(name) : "")) {
    v1Only.push(name);
    continue;
  }
  const rebuilt: Record<string, unknown> = {};
  for (const key of Object.keys(caseJson)) {
    if (key === "config") {
      rebuilt.configV2 = convertedV2.value;
    } else {
      rebuilt[key] = caseJson[key];
    }
  }
  writeFileSync(join(CASES, name, "case.json"), `${JSON.stringify(rebuilt, null, INDENT)}\n`);
  converted += 1;
}

for (const name of v1Only) {
  console.log(`v1-only ${name}`);
}
console.log(`converted ${converted}, v1-only ${v1Only.length}`);
