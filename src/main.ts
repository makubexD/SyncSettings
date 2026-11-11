import pkg from "../package.json" with { type: "json" };

export const USAGE = "usage: mksync export|import [--force] [--only <path>...] | mksync --version";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(argv: readonly string[]): Result {
  const [first] = argv;
  if (first === "--version") {
    return { code: 0, stdout: `mksync ${pkg.version}\n`, stderr: "" };
  }
  if (first !== undefined && first.startsWith("-")) {
    return { code: 1, stdout: "", stderr: `Unknown option: ${first}\n` };
  }
  return { code: 2, stdout: "", stderr: `${USAGE}\n` };
}

if (import.meta.main) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
