import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { icaclsArgs, parseWhoamiSid, restrictToCurrentUser } from "./acl.ts";

const VALUES_PATH = "C:\\r\\.user-values.json";
const SID = "S-1-5-21-1-2-3-1001";
const NO_INHERITANCE = "/inheritance:r";
const REPLACE_GRANT = "/grant:r";
const GRANT_INDEX = 3;
const FILE_MODE = 0o640;
const MODE_MASK = 0o777;

function icaclsArgsFor(sid: string): readonly string[] {
  return icaclsArgs(VALUES_PATH, sid);
}

describe("icaclsArgs", () => {
  test("should build the owner-only grant for a SID (values-private-new)", () => {
    // Act
    const args = icaclsArgsFor(SID);

    // Assert
    expect(args).toEqual([
      VALUES_PATH,
      NO_INHERITANCE,
      REPLACE_GRANT,
      `*${SID}:F`,
    ]);
  });

  test("should grant by SID with no name or domain (values-private-no-domain)", () => {
    // Act
    const args = icaclsArgsFor(SID);

    // Assert
    expect(args).not.toContain("/grant");
    expect(args[GRANT_INDEX]).toStartWith("*S-1-");
    expect(args[GRANT_INDEX]).not.toContain("\\");
    expect(args).not.toContain("domain");
  });

  test("should remove inherited access before granting (values-private-tightened)", () => {
    // Act
    const args = icaclsArgsFor(SID);

    // Assert
    expect(args.indexOf(NO_INHERITANCE)).toBeLessThan(
      args.indexOf(REPLACE_GRANT),
    );
    expect(args).toContain(REPLACE_GRANT);
    expect(args).not.toContain("/grant");
  });

  test("should throw a RangeError when the SID is a name", () => {
    expect(() => icaclsArgsFor("DOMAIN\\me")).toThrow(RangeError);
  });

  test("should throw a RangeError when the SID is empty", () => {
    expect(() => icaclsArgsFor("")).toThrow(RangeError);
  });
});

describe("parseWhoamiSid", () => {
  test("should return the SID from a CRLF whoami line", () => {
    // Act
    const sid = parseWhoamiSid(`"desktop\\me","${SID}"\r\n`);

    // Assert
    expect(sid).toBe(SID);
  });

  test("should return undefined when whoami prints no SID", () => {
    expect(parseWhoamiSid("garbage")).toBeUndefined();
  });

  test("should return undefined for empty output", () => {
    expect(parseWhoamiSid("")).toBeUndefined();
  });
});

describe("restrictToCurrentUser", () => {
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0)) {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "should leave the mode unchanged outside Windows",
    () => {
      // Arrange
      const folder = mkdtempSync(join(tmpdir(), "mksync-acl-"));
      folders.push(folder);
      const path = join(folder, "file");
      writeFileSync(path, "x");
      chmodSync(path, FILE_MODE);

      // Act
      restrictToCurrentUser(path);

      // Assert
      expect(statSync(path).mode & MODE_MASK).toBe(FILE_MODE);
    },
  );
});
