import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readConfig(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    fail(`cannot read ${path}: ${(error as Error).message}`);
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`cannot parse ${path}: ${(error as Error).message}`);
  }
}

function foldCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function gitVersion(): string {
  try {
    const output = execFileSync("git", ["--version"], { encoding: "utf8" });
    return output.split(/\r?\n/)[0];
  } catch {
    return "not found";
  }
}

const repo = process.argv[2];
if (!repo) {
  fail("usage: main <repo>");
}

const configPath = join(repo, "sync-config.json");
const raw = readConfig(configPath);
const config = parseJson(raw.toString("utf8"), configPath);

const files = (config as { files?: unknown } | null)?.files;
if (!Array.isArray(files)) {
  fail(`${configPath} has no files array`);
}

const lines = [
  `entries: ${files.length}`,
  `sha256: ${createHash("sha256").update(raw).digest("hex")}`,
  `crlf-fold: ${
    foldCrlf("a\r\nb\n") === foldCrlf("a\nb\n") ? "equal" : "different"
  }`,
  `git: ${gitVersion()}`,
  `os: ${process.platform}-${process.arch}`,
];

process.stdout.write(`${lines.join("\n")}\n`);
