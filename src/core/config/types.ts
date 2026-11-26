export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ConfigError {
  readonly message: string;
  readonly code: 1 | 2;
  /** Set when the error is a missing value, naming its placeholder. */
  readonly placeholder?: string;
}

export type Os = "windows" | "linux" | "macos";

export type EntryType = "file" | "dir" | "dconf";

/** Where a prompt's suggested default comes from (contract "Sanitize and hydrate"). */
export const SUGGEST_SOURCES = [
  "gh-login",
  "git-user-name",
  "git-user-email",
] as const;

export type SuggestSource = (typeof SUGGEST_SOURCES)[number];

export interface SanitizeRule {
  readonly placeholder: string;
  readonly prompt: string;
  readonly default?: string;
  readonly defaultEnv?: string;
  readonly escapeBackslashes?: boolean;
  readonly suggest?: SuggestSource;
}

export type MergeType = "whole" | "json" | "import" | "dconf" | "dir";

export interface ConfigV2Module {
  readonly description: string;
  readonly os?: readonly Os[];
}

export interface ConfigV2Entry {
  readonly file: string;
  readonly module: string;
  readonly merge: MergeType;
  readonly localPath?: string;
  readonly localPaths?: Readonly<Partial<Record<Os, string>>>;
  readonly os?: readonly Os[];
  readonly sanitize?: readonly SanitizeRule[];
  readonly localOnlyKeys?: readonly string[];
  readonly importName?: string;
  readonly dconfPath?: string;
  readonly keys?: readonly string[];
  readonly elevate?: false;
  /** A file entry read for linked folders (contract "Linked folders"). */
  readonly linked?: true;
  readonly description?: string;
}

export interface ConfigV2 {
  readonly schemaVersion: 2;
  readonly excludePatterns?: readonly string[];
  readonly modules: Readonly<Record<string, ConfigV2Module>>;
  readonly entries: readonly ConfigV2Entry[];
}
