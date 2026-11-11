export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ConfigError {
  readonly message: string;
  readonly code: 1;
}

export type Os = "windows" | "linux" | "macos";

export type PlatformName = "common" | Os;

export type Platform = PlatformName | readonly Os[];

export type EntryType = "file" | "dir" | "dconf";

export interface SanitizeRule {
  readonly placeholder: string;
  readonly prompt: string;
  readonly default?: string;
  readonly defaultEnv?: string;
  readonly escapeBackslashes?: boolean;
}

export interface ConfigV1Entry {
  readonly repoPath: string;
  readonly localPath?: string;
  readonly localPaths?: Readonly<Partial<Record<Os, string>>>;
  readonly platform: Platform;
  readonly description?: string;
  readonly sanitizeRules?: readonly SanitizeRule[];
  readonly type?: EntryType;
  readonly path?: string;
  readonly keys?: readonly string[];
  readonly detectLinkedPaths?: boolean;
}

export interface ConfigV1 {
  readonly version?: number;
  readonly defaultUser?: string | null;
  readonly files: readonly ConfigV1Entry[];
  readonly excludePatterns?: readonly string[];
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
  readonly scanLinks?: boolean;
  readonly elevate?: false;
  readonly description?: string;
}

export interface ConfigV2 {
  readonly schemaVersion: 2;
  readonly excludePatterns?: readonly string[];
  readonly modules: Readonly<Record<string, ConfigV2Module>>;
  readonly entries: readonly ConfigV2Entry[];
}
