import { describe, expect, test } from "bun:test";
import { jsonEqual, parseJson, writeJson } from "../json/value.ts";
import type { JsonValue } from "../json/value.ts";
import { mergeJson, mergeJsonValues, splitJson } from "./json.ts";
import type { JsonLayer, JsonSplit, LayerName, NewSetting } from "./json.ts";
import type { LayerChange, LayerFile } from "./types.ts";

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

const OS_PATH = "dotfiles/linux/vscode/settings.json";

const MARKET_A = "https://marketplace.example.com/a";
const MARKET_B = "https://marketplace.example.com/b";
const MARKET_C = "https://marketplace.example.com/c";

const CASE1_BASE_TEXT = '{"editor.fontSize": 14}';
const CASE1_LOCAL_TEXT = '{"editor.fontSize": 15}';
const CASE1_BASE_CHANGE_TEXT = `{
  "editor.fontSize": 15
}
`;

const CASE2_LOCAL_TEXT = `{
  "editor.fontSize": 14,
  "http.proxy": "http://proxy.new.example.com:9999"
}
`;
const CASE2_PROFILE_CHANGE_TEXT = `{
  "http.proxy": "http://proxy.new.example.com:9999"
}
`;

const MARKETPLACES_BASE_TEXT = `{
  "chat.plugins.marketplaces": [
    "${MARKET_A}",
    "${MARKET_B}"
  ]
}
`;
const MARKETPLACES_LOCAL_TEXT = `{
  "chat.plugins.marketplaces": [
    "${MARKET_A}",
    "${MARKET_B}",
    "${MARKET_C}"
  ],
  "http.proxy": "http://proxy.example.com:8080"
}
`;
const MARKETPLACES_PROFILE_CHANGE_TEXT = `{
  "http.proxy": "http://proxy.example.com:8080",
  "chat.plugins.marketplaces": [
    "${MARKET_C}"
  ]
}
`;

const MARKETPLACES_REMOVED_LOCAL_TEXT = `{
  "chat.plugins.marketplaces": [
    "${MARKET_A}"
  ]
}
`;
const MARKETPLACES_REMOVED_BASE_CHANGE_TEXT = `{
  "chat.plugins.marketplaces": [
    "${MARKET_A}"
  ]
}
`;

const ALLOW_BASE_TEXT = `{
  "permissions": {
    "allow": [
      "Bash(git:*)"
    ]
  }
}
`;
const ALLOW_LOCAL_TEXT = `{
  "http.proxy": "http://proxy.example.com:8080",
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm test:*)"
    ]
  }
}
`;
const ALLOW_PROFILE_CHANGE_TEXT = `{
  "http.proxy": "http://proxy.example.com:8080",
  "permissions": {
    "allow": [
      "Bash(npm test:*)"
    ]
  }
}
`;

const AGENT_ENABLED_LOCAL_TEXT = `{
  "editor.fontSize": 14,
  "http.proxy": "http://proxy.example.com:8080",
  "chat.agent.enabled": true
}
`;

const REORDER_BASE_TEXT = '{"a": 1, "b": 2}';
const REORDER_LOCAL_CRLF_TEXT = '{\r\n  "b": 2,\r\n  "a": 1\r\n}\r\n';

const PULL_BASE_TEXT = '{"a": 1, "list": ["x"], "obj": {"k": "base"}}';
const PULL_OS_TEXT = '{"list": ["y", "x"], "obj": {"k2": "os"}, "b": 2}';

const ONE_LAYER_BASE_TEXT = '{"a": 1}';
const ONE_LAYER_NEW_KEY_LOCAL_TEXT = `{
  "a": 1,
  "x": true
}
`;
const ONE_LAYER_NEW_KEY_BASE_CHANGE_TEXT = ONE_LAYER_NEW_KEY_LOCAL_TEXT;

const LIST_BASE_TEXT = '{"list": ["x"]}';
const LIST_ADDED_LOCAL_TEXT = `{
  "list": [
    "x",
    "y"
  ]
}
`;
const LIST_PROFILE_CHANGE_TEXT = `{
  "list": [
    "y"
  ]
}
`;

const SINGLE_BASE_TEXT = '{"a": 1, "list": ["x"]}';
const SINGLE_LOCAL_TEXT = `{
  "a": 2,
  "list": [
    "x",
    "y"
  ],
  "b": true
}
`;
const SINGLE_BASE_CHANGE_TEXT = SINGLE_LOCAL_TEXT;

const NEW_PROFILE_LOCAL_TEXT = `{
  "editor.fontSize": 14,
  "http.proxy": "http://proxy.example.com:8080"
}
`;
const NEW_PROFILE_CHANGE_TEXT = `{
  "http.proxy": "http://proxy.example.com:8080"
}
`;

const REMOVE_BASE_TEXT = '{"a": 1, "keep": "base"}';
const REMOVE_OS_TEXT = '{"a": 2}';
const REMOVE_LOCAL_TEXT = '{"keep": "base"}';
const REMOVE_BASE_CHANGE_TEXT = `{
  "keep": "base"
}
`;
const REMOVE_OS_CHANGE_TEXT = "{}\n";

const SPLIT_LOCAL_ONLY_BASE_TEXT =
  '{"editor.fontSize": 14, "window.zoomLevel": 0}';
const SPLIT_LOCAL_ONLY_LOCAL_TEXT =
  '{"editor.fontSize": 14, "window.zoomLevel": 2}';
const SPLIT_LOCAL_ONLY_ADDED_TEXT = '{"editor.fontSize": 14, "window.zoomLevel": 2}';

const DESTINATION_ALLOW = new Map<string, LayerName>([
  ["permissions.allow[]", "profile"],
]);
const DESTINATION_MARKETPLACES = new Map<string, LayerName>([
  ["chat.plugins.marketplaces[]", "profile"],
]);
const DESTINATION_PROXY = new Map<string, LayerName>([
  ["http.proxy", "profile"],
]);
const DESTINATION_LIST = new Map<string, LayerName>([["list[]", "profile"]]);
const DESTINATION_MACHINE = new Map<string, LayerName>([["x", "machine"]]);

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function jsonLayer(
  name: LayerName,
  repoPath: string,
  text: string | undefined,
): JsonLayer {
  return { name, repoPath, bytes: text === undefined ? undefined : bytes(text) };
}

function split(
  localText: string,
  layers: readonly JsonLayer[],
  options: {
    readonly destinations?: ReadonlyMap<string, LayerName>;
    readonly localOnlyKeys?: readonly string[];
  } = {},
): JsonSplit {
  const result = splitJson(bytes(localText), layers, options);
  if (!result.ok) {
    throw new Error(`expected a split, got ${result.error}`);
  }
  return result.value;
}

function applyChanges(
  layers: readonly JsonLayer[],
  changes: readonly LayerChange[],
): JsonValue[] {
  const values: JsonValue[] = [];
  for (const layer of layers) {
    const change = changes.find(
      (candidate) => candidate.repoPath === layer.repoPath,
    );
    if (change !== undefined) {
      values.push(parseOk(decode(change.bytes)));
    } else if (layer.bytes !== undefined) {
      values.push(parseOk(decode(layer.bytes)));
    }
  }
  return values;
}

function withoutLocalOnly(
  value: JsonValue,
  keys: readonly string[],
): JsonValue {
  if (value.kind !== "object" || keys.length === 0) {
    return value;
  }
  const entries = new Map(value.entries);
  for (const key of keys) {
    entries.delete(key);
  }
  return { kind: "object", entries };
}

/** The property: applying a split's changes and merging again equals the local
 * file parsed (localOnlyKeys aside). Used by every non-error case. */
function expectRoundTrip(
  localText: string,
  layers: readonly JsonLayer[],
  options: {
    readonly destinations?: ReadonlyMap<string, LayerName>;
    readonly localOnlyKeys?: readonly string[];
  } = {},
): JsonSplit {
  const result = split(localText, layers, options);
  const localOnlyKeys = options.localOnlyKeys ?? [];
  const values = applyChanges(layers, result.changes);
  const merged = values.length === 0 ? parseOk("{}") : mergeJsonValues(values);
  expect(
    jsonEqual(
      withoutLocalOnly(merged, localOnlyKeys),
      withoutLocalOnly(parseOk(localText), localOnlyKeys),
    ),
  ).toBe(true);
  return result;
}

function expectLayerText(
  changes: readonly LayerChange[],
  repoPath: string,
  text: string,
): void {
  const change = changes.find((candidate) => candidate.repoPath === repoPath);
  expect(change).toBeDefined();
  expect(change === undefined ? "" : decode(change.bytes)).toBe(text);
}

function expectNoLayerChange(
  changes: readonly LayerChange[],
  repoPath: string,
): void {
  expect(changes.some((change) => change.repoPath === repoPath)).toBe(false);
}

function expectNewSettings(
  settings: readonly NewSetting[],
  expected: readonly { readonly path: string; readonly json: string }[],
): void {
  expect(settings).toHaveLength(expected.length);
  expected.forEach((entry, index) => {
    const setting = settings[index];
    expect(setting?.path).toBe(entry.path);
    expect(
      setting === undefined ? false : jsonEqual(setting.value, parseOk(entry.json)),
    ).toBe(true);
  });
}

describe("splitJson", () => {
  test("case 1: a changed base key goes to the base layer", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, CASE1_BASE_TEXT)];

    // Act
    const result = expectRoundTrip(CASE1_LOCAL_TEXT, layers);

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(result.changes, BASE_PATH, CASE1_BASE_CHANGE_TEXT);
  });

  test("case 2: a changed profile key goes to the profile layer", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, CASE1_BASE_TEXT),
      jsonLayer("profile", PROFILE_PATH, PROFILE_PROXY_TEXT),
    ];

    // Act
    const result = expectRoundTrip(CASE2_LOCAL_TEXT, layers);

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(result.changes, PROFILE_PATH, CASE2_PROFILE_CHANGE_TEXT);
    expectNoLayerChange(result.changes, BASE_PATH);
  });

  test("case 3: a new array item with no destination is a new setting and writes nothing", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, MARKETPLACES_BASE_TEXT),
      jsonLayer("profile", PROFILE_PATH, PROFILE_PROXY_TEXT),
    ];

    // Act
    const result = split(MARKETPLACES_LOCAL_TEXT, layers);

    // Assert
    expect(result.changes).toEqual([]);
    expectNewSettings(result.newSettings, [
      { path: "chat.plugins.marketplaces[]", json: `"${MARKET_C}"` },
    ]);
  });

  test("case 3: a new array item with a profile destination goes to the profile layer", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, MARKETPLACES_BASE_TEXT),
      jsonLayer("profile", PROFILE_PATH, PROFILE_PROXY_TEXT),
    ];

    // Act
    const result = expectRoundTrip(MARKETPLACES_LOCAL_TEXT, layers, {
      destinations: DESTINATION_MARKETPLACES,
    });

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(
      result.changes,
      PROFILE_PATH,
      MARKETPLACES_PROFILE_CHANGE_TEXT,
    );
    expectNoLayerChange(result.changes, BASE_PATH);
  });

  test("case 4: a removed base array item is removed from the base layer", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, MARKETPLACES_BASE_TEXT)];

    // Act
    const result = expectRoundTrip(MARKETPLACES_REMOVED_LOCAL_TEXT, layers);

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(
      result.changes,
      BASE_PATH,
      MARKETPLACES_REMOVED_BASE_CHANGE_TEXT,
    );
  });

  test("case 5: Claude's rewrite with own key order sends only the new allow item to the profile", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, ALLOW_BASE_TEXT),
      jsonLayer("profile", PROFILE_PATH, PROFILE_PROXY_TEXT),
    ];

    // Act
    const result = expectRoundTrip(ALLOW_LOCAL_TEXT, layers, {
      destinations: DESTINATION_ALLOW,
    });

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(result.changes, PROFILE_PATH, ALLOW_PROFILE_CHANGE_TEXT);
    expectNoLayerChange(result.changes, BASE_PATH);
  });

  test("case 6: a new top-level key with no destination is a new setting", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, CASE1_BASE_TEXT),
      jsonLayer("profile", PROFILE_PATH, PROFILE_PROXY_TEXT),
    ];

    // Act
    const result = split(AGENT_ENABLED_LOCAL_TEXT, layers);

    // Assert
    expect(result.changes).toEqual([]);
    expectNewSettings(result.newSettings, [
      { path: "chat.agent.enabled", json: "true" },
    ]);
  });

  test("case 9: CRLF and key reordering alone are no change", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, REORDER_BASE_TEXT)];

    // Act
    const result = expectRoundTrip(REORDER_LOCAL_CRLF_TEXT, layers);

    // Assert
    expect(result.changes).toEqual([]);
    expect(result.newSettings).toEqual([]);
  });

  test("a push right after a pull finds no change", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, PULL_BASE_TEXT),
      jsonLayer("os", OS_PATH, PULL_OS_TEXT),
    ];
    const localText = writeJson(
      mergeJsonValues([parseOk(PULL_BASE_TEXT), parseOk(PULL_OS_TEXT)]),
      LF,
    );

    // Act
    const result = expectRoundTrip(localText, layers);

    // Assert
    expect(result.changes).toEqual([]);
    expect(result.newSettings).toEqual([]);
  });

  test("a single layer slot takes every change, new key and new item", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, SINGLE_BASE_TEXT)];

    // Act
    const result = expectRoundTrip(SINGLE_LOCAL_TEXT, layers);

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(result.changes, BASE_PATH, SINGLE_BASE_CHANGE_TEXT);
  });

  test("a missing OS slot leaves the one present base layer to take a new key", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, ONE_LAYER_BASE_TEXT),
      jsonLayer("os", OS_PATH, undefined),
    ];

    // Act
    const result = expectRoundTrip(ONE_LAYER_NEW_KEY_LOCAL_TEXT, layers);

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(
      result.changes,
      BASE_PATH,
      ONE_LAYER_NEW_KEY_BASE_CHANGE_TEXT,
    );
    expectNoLayerChange(result.changes, OS_PATH);
  });

  test("a missing OS slot leaves the one present base layer to take a new array item", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, LIST_BASE_TEXT),
      jsonLayer("os", OS_PATH, undefined),
    ];

    // Act
    const result = expectRoundTrip(LIST_ADDED_LOCAL_TEXT, layers);

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(result.changes, BASE_PATH, LIST_ADDED_LOCAL_TEXT);
    expectNoLayerChange(result.changes, OS_PATH);
  });

  test("an array item's destination looks up the path the note names, with []", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, LIST_BASE_TEXT),
      jsonLayer("os", OS_PATH, undefined),
      jsonLayer("profile", PROFILE_PATH, undefined),
    ];

    // Act
    const result = expectRoundTrip(LIST_ADDED_LOCAL_TEXT, layers, {
      destinations: DESTINATION_LIST,
    });

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(result.changes, PROFILE_PATH, LIST_PROFILE_CHANGE_TEXT);
    expectNoLayerChange(result.changes, BASE_PATH);
  });

  test("a destination naming a slot this run lacks falls back to the one present layer", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, ONE_LAYER_BASE_TEXT)];

    // Act
    const result = expectRoundTrip(ONE_LAYER_NEW_KEY_LOCAL_TEXT, layers, {
      destinations: DESTINATION_MACHINE,
    });

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(
      result.changes,
      BASE_PATH,
      ONE_LAYER_NEW_KEY_BASE_CHANGE_TEXT,
    );
  });

  test("two present layers with no destination leave a new key a new setting", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, ONE_LAYER_BASE_TEXT),
      jsonLayer("os", OS_PATH, REMOVE_OS_TEXT),
    ];

    // Act
    const result = split(ONE_LAYER_NEW_KEY_LOCAL_TEXT, layers);

    // Assert
    expect(result.changes).toEqual([]);
    expectNewSettings(result.newSettings, [{ path: "x", json: "true" }]);
  });

  test("a destination naming a profile slot with no file yet creates the profile file", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, CASE1_BASE_TEXT),
      jsonLayer("profile", PROFILE_PATH, undefined),
    ];

    // Act
    const result = expectRoundTrip(NEW_PROFILE_LOCAL_TEXT, layers, {
      destinations: DESTINATION_PROXY,
    });

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expectLayerText(result.changes, PROFILE_PATH, NEW_PROFILE_CHANGE_TEXT);
    expectNoLayerChange(result.changes, BASE_PATH);
  });

  test("a removed key set by the base and the OS is removed from both", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, REMOVE_BASE_TEXT),
      jsonLayer("os", OS_PATH, REMOVE_OS_TEXT),
    ];

    // Act
    const result = expectRoundTrip(REMOVE_LOCAL_TEXT, layers);

    // Assert
    expect(result.newSettings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    expectLayerText(result.changes, BASE_PATH, REMOVE_BASE_CHANGE_TEXT);
    expectLayerText(result.changes, OS_PATH, REMOVE_OS_CHANGE_TEXT);
  });

  test("a localOnly key that differs is not a change", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, SPLIT_LOCAL_ONLY_BASE_TEXT)];

    // Act
    const result = expectRoundTrip(SPLIT_LOCAL_ONLY_LOCAL_TEXT, layers, {
      localOnlyKeys: ["window.zoomLevel"],
    });

    // Assert
    expect(result.changes).toEqual([]);
    expect(result.newSettings).toEqual([]);
  });

  test("a localOnly key only the local file holds is not a new setting", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, CASE1_BASE_TEXT)];

    // Act
    const result = expectRoundTrip(SPLIT_LOCAL_ONLY_ADDED_TEXT, layers, {
      localOnlyKeys: ["window.zoomLevel"],
    });

    // Assert
    expect(result.changes).toEqual([]);
    expect(result.newSettings).toEqual([]);
  });

  test("a local file that isn't valid JSON is an error", () => {
    // Arrange
    const layers = [jsonLayer("base", BASE_PATH, CASE1_BASE_TEXT)];

    // Act
    const result = splitJson(bytes("{ not JSON"), layers, {});

    // Assert
    expect(result).toEqual({ ok: false, error: "not valid JSON" });
  });

  test("a layer that isn't valid JSON is an error naming the layer", () => {
    // Arrange
    const layers = [
      jsonLayer("base", BASE_PATH, CASE1_BASE_TEXT),
      jsonLayer("os", OS_PATH, "{ not JSON"),
    ];

    // Act
    const result = splitJson(bytes(CASE1_LOCAL_TEXT), layers, {});

    // Assert
    expect(result).toEqual({
      ok: false,
      error: `not valid JSON: ${OS_PATH}`,
    });
  });
});
