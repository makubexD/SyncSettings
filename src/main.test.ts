import { describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { parseValuesText, run, USAGE } from "./main.ts";

describe("mksync front", () => {
  test("--version prints the package version and exits 0", () => {
    expect(run(["--version"])).toEqual({ code: 0, stdout: `mksync ${pkg.version}\n`, stderr: "" });
  });

  test("no command prints the usage line and exits 2", () => {
    expect(run([])).toEqual({ code: 2, stdout: "", stderr: `${USAGE}\n` });
  });

  test("an unknown command prints the usage line and exits 2", () => {
    expect(run(["frobnicate"])).toEqual({ code: 2, stdout: "", stderr: `${USAGE}\n` });
  });

  test("an unknown option prints Unknown option and exits 1", () => {
    expect(run(["--bogus"])).toEqual({ code: 1, stdout: "", stderr: "Unknown option: --bogus\n" });
  });
});

describe("parseValuesText", () => {
  test("should read a number as its text", () => {
    // Arrange
    const text = '{"<PORT>": 8080}';

    // Act
    const values = parseValuesText(text);

    // Assert
    expect(values).toEqual({ "<PORT>": "8080" });
  });

  test("should read true as its text", () => {
    // Arrange
    const text = '{"<FLAG>": true}';

    // Act
    const values = parseValuesText(text);

    // Assert
    expect(values).toEqual({ "<FLAG>": "true" });
  });

  test("should read null as the text null", () => {
    // Arrange
    const text = '{"<EMPTY>": null}';

    // Act
    const values = parseValuesText(text);

    // Assert
    expect(values).toEqual({ "<EMPTY>": "null" });
  });

  test("should keep a string as it is", () => {
    // Arrange
    const text = '{"<NAME>": "me"}';

    // Act
    const values = parseValuesText(text);

    // Assert
    expect(values).toEqual({ "<NAME>": "me" });
  });

  test("should write an object as compact JSON", () => {
    // Arrange
    const text = '{"<SETTINGS>": {"size": 2}}';

    // Act
    const values = parseValuesText(text);

    // Assert
    expect(values).toEqual({ "<SETTINGS>": '{"size":2}' });
  });

  test("should be empty when the file is missing", () => {
    expect(parseValuesText(undefined)).toEqual({});
  });

  test("should be empty when the file is not JSON", () => {
    expect(parseValuesText("{")).toEqual({});
  });
});
