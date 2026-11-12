import { describe, expect, test } from "bun:test";
import { parseJson, writeJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import { mergeJson, mergeJsonValues } from "./json.ts";
import type { LayerFile } from "./types.ts";

const LF = "\n";
const CRLF = "\r\n";

const BASE_PATH = "dotfiles/common/vscode/settings.json";
const PROFILE_PATH = "profiles/work-1/vscode/settings.json";
const MACHINE_PATH = "machines/work-1/vscode/settings.json";

const BASE_FONT_SIZE_TEXT = '{"editor.fontSize": 14}';
const PROFILE_PROXY_TEXT = '{"http.proxy": "http://proxy.example.com:8080"}';
const MACHINE_FONT_SIZE_TEXT = '{"editor.fontSize": 16}';
const WORK_MACHINE_FILE_TEXT = `{
  "editor.fontSize": 16,
  "http.proxy": "http://proxy.example.com:8080"
}
`;
const PERSONAL_FILE_TEXT = `{
  "editor.fontSize": 14
}
`;

const CLAUDE_BASE_TEXT = `{
  "permissions": {
    "allow": ["Bash(git:*)"],
    "defaultMode": "auto"
  }
}`;
const CLAUDE_WINDOWS_TEXT = `{
  "permissions": {
    "allow": ["PowerShell(Get-ChildItem:*)"]
  }
}`;
const CLAUDE_MERGED_TEXT = `{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "PowerShell(Get-ChildItem:*)"
    ],
    "defaultMode": "auto"
  }
}`;

const OBJECT_BASE_TEXT = '{"editor": {"fontSize": 14}}';
const SCALAR_LATER_TEXT = '{"editor": "disabled"}';
const SCALAR_WINS_TEXT = '{"editor": "disabled"}';

const REORDERED_ITEM_BASE_TEXT =
  '{"permissions": {"allow": [{"tool": "git", "mode": "read"}]}}';
const REORDERED_ITEM_LATER_TEXT =
  '{"permissions": {"allow": [{"mode": "read", "tool": "git"}]}}';

const ORDER_BASE_TEXT = '{"a": 1, "c": 3}';
const ORDER_LATER_TEXT = '{"b": 2, "c": 30, "d": 4}';
const ORDER_MERGED_TEXT = `{
  "a": 1,
  "c": 30,
  "b": 2,
  "d": 4
}
`;

const COMMENT_LAYER_TEXT = `{
  // a comment
  "editor.fontSize": 14
}`;

const ZOOM_KEY = "window.zoomLevel";
const LOCAL_ONLY_BASE_TEXT = '{"window.zoomLevel": 0, "editor.fontSize": 14}';
const LOCAL_ONLY_LOCAL_TEXT = '{"window.zoomLevel": 2}';
const LOCAL_OVERRIDE_FILE_TEXT = `{
  "window.zoomLevel": 2,
  "editor.fontSize": 14
}
`;
const BASE_ONLY_TEXT = '{"editor.fontSize": 14}';
const APPENDED_FILE_TEXT = `{
  "editor.fontSize": 14,
  "window.zoomLevel": 2
}
`;
const REMOVED_FILE_TEXT = `{
  "editor.fontSize": 14
}
`;
const INVALID_LOCAL_TEXT = "{ not JSON";

const BASE_ONLY_CRLF_TEXT = '{\r\n  "editor.fontSize": 14\r\n}\r\n';
const NUMBER_TEXT = '{"editor.fontSize": 1.0}';
const NUMBER_FILE_TEXT = `{
  "editor.fontSize": 1.0
}
`;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function layer(repoPath: string, text: string): LayerFile {
  return { repoPath, bytes: bytes(text) };
}

function parseOk(text: string): JsonValue {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    throw new Error(`expected valid JSON, got ${parsed.error}`);
  }
  return parsed.value;
}

function mergeText(
  layers: readonly LayerFile[],
  eol: "\n" | "\r\n" = LF,
  local?: {
    readonly bytes: Uint8Array | undefined;
    readonly localOnlyKeys: readonly string[];
  },
): string {
  const result = mergeJson(layers, eol, local);
  if (!result.ok) {
    throw new Error(`expected a merge, got ${result.error}`);
  }
  return new TextDecoder().decode(result.value);
}

describe("mergeJsonValues", () => {
  test("the Layers example gives the machine's font size and the profile's proxy", () => {
    // Arrange
    const layers = [
      layer(BASE_PATH, BASE_FONT_SIZE_TEXT),
      layer(PROFILE_PATH, PROFILE_PROXY_TEXT),
      layer(MACHINE_PATH, MACHINE_FONT_SIZE_TEXT),
    ];

    // Act
    const result = mergeText(layers);

    // Assert
    expect(result).toBe(WORK_MACHINE_FILE_TEXT);
  });

  test("a personal machine gets the base font size and no proxy", () => {
    // Arrange
    const layers = [layer(BASE_PATH, BASE_FONT_SIZE_TEXT)];

    // Act
    const result = mergeText(layers);

    // Assert
    expect(result).toBe(PERSONAL_FILE_TEXT);
  });

  test("the Claude example collects allow items and keeps the base's defaultMode", () => {
    // Arrange
    const base = parseOk(CLAUDE_BASE_TEXT);
    const windows = parseOk(CLAUDE_WINDOWS_TEXT);

    // Act
    const result = mergeJsonValues([base, windows]);

    // Assert
    expect(result).toEqual(parseOk(CLAUDE_MERGED_TEXT));
  });

  test("an object in the base and a scalar in a later layer: the later layer wins", () => {
    // Arrange
    const base = parseOk(OBJECT_BASE_TEXT);
    const later = parseOk(SCALAR_LATER_TEXT);

    // Act
    const result = mergeJsonValues([base, later]);

    // Assert
    expect(result).toEqual(parseOk(SCALAR_WINS_TEXT));
  });

  test("an array item equal with its keys reordered is not repeated", () => {
    // Arrange
    const base = parseOk(REORDERED_ITEM_BASE_TEXT);
    const later = parseOk(REORDERED_ITEM_LATER_TEXT);

    // Act
    const result = mergeJsonValues([base, later]);

    // Assert
    expect(result).toEqual(base);
  });

  test("keys keep their position and new keys follow the later layer's order", () => {
    // Arrange
    const base = parseOk(ORDER_BASE_TEXT);
    const later = parseOk(ORDER_LATER_TEXT);

    // Act
    const result = mergeJsonValues([base, later]);

    // Assert
    expect(writeJson(result, LF)).toBe(ORDER_MERGED_TEXT);
  });

  test("no layers is a RangeError", () => {
    // Act
    const merge = () => mergeJsonValues([]);

    // Assert
    expect(merge).toThrow(RangeError);
  });
});

describe("mergeJson", () => {
  test("a layer that isn't valid JSON is an error naming the layer", () => {
    // Arrange
    const base = layer(BASE_PATH, BASE_FONT_SIZE_TEXT);
    const invalid = layer(PROFILE_PATH, COMMENT_LAYER_TEXT);

    // Act
    const result = mergeJson([base, invalid], LF);

    // Assert
    expect(result).toEqual({
      ok: false,
      error: `not valid JSON: ${PROFILE_PATH}`,
    });
  });

  test("a localOnly key takes the local file's value, not the layers'", () => {
    // Arrange
    const layers = [layer(BASE_PATH, LOCAL_ONLY_BASE_TEXT)];
    const local = {
      bytes: bytes(LOCAL_ONLY_LOCAL_TEXT),
      localOnlyKeys: [ZOOM_KEY],
    };

    // Act
    const result = mergeText(layers, LF, local);

    // Assert
    expect(result).toBe(LOCAL_OVERRIDE_FILE_TEXT);
  });

  test("a localOnly key only the local file has is appended at the end", () => {
    // Arrange
    const layers = [layer(BASE_PATH, BASE_ONLY_TEXT)];
    const local = {
      bytes: bytes(LOCAL_ONLY_LOCAL_TEXT),
      localOnlyKeys: [ZOOM_KEY],
    };

    // Act
    const result = mergeText(layers, LF, local);

    // Assert
    expect(result).toBe(APPENDED_FILE_TEXT);
  });

  test("a localOnly key the local file lacks is removed", () => {
    // Arrange
    const layers = [layer(BASE_PATH, LOCAL_ONLY_BASE_TEXT)];
    const local = { bytes: bytes("{}"), localOnlyKeys: [ZOOM_KEY] };

    // Act
    const result = mergeText(layers, LF, local);

    // Assert
    expect(result).toBe(REMOVED_FILE_TEXT);
  });

  test("a local file that isn't valid JSON holds no localOnly keys", () => {
    // Arrange
    const layers = [layer(BASE_PATH, LOCAL_ONLY_BASE_TEXT)];
    const local = {
      bytes: bytes(INVALID_LOCAL_TEXT),
      localOnlyKeys: [ZOOM_KEY],
    };

    // Act
    const result = mergeText(layers, LF, local);

    // Assert
    expect(result).toBe(REMOVED_FILE_TEXT);
  });

  test("a missing local file holds no localOnly keys", () => {
    // Arrange
    const layers = [layer(BASE_PATH, LOCAL_ONLY_BASE_TEXT)];
    const local = { bytes: undefined, localOnlyKeys: [ZOOM_KEY] };

    // Act
    const result = mergeText(layers, LF, local);

    // Assert
    expect(result).toBe(REMOVED_FILE_TEXT);
  });

  test("CRLF is the line ending when asked", () => {
    // Arrange
    const layers = [layer(BASE_PATH, BASE_ONLY_TEXT)];

    // Act
    const result = mergeText(layers, CRLF);

    // Assert
    expect(result).toBe(BASE_ONLY_CRLF_TEXT);
  });

  test("a number keeps the text its layer writes", () => {
    // Arrange
    const layers = [layer(BASE_PATH, NUMBER_TEXT)];

    // Act
    const result = mergeText(layers);

    // Assert
    expect(result).toBe(NUMBER_FILE_TEXT);
  });
});
