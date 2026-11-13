import type { Profile } from "../config/profile.ts";
import { mergeProfileCopies } from "./copies.ts";
import type { CopyQuestion } from "./copies.ts";
import type { MachineRecord } from "./record.ts";

const PROFILES_FOLDER = "profiles";

const MACHINES_FOLDER = "machines";

const JSON_EXTENSION = ".json";

/** One layer's file: where it sits inside the layer folder and its text. */
export interface LayerFile {
  readonly path: string;
  readonly text: string;
}

/** What this machine holds before the first backup. */
export interface LocalBackup {
  readonly profile: Profile;
  readonly profileLayer: readonly LayerFile[];
  readonly record: MachineRecord;
  readonly machineLayer: readonly LayerFile[];
}

/** What the repo already holds for this profile: its `profiles/<name>.json`.
 * Layer files are always written from this machine (contract, "The first
 * backup"); the adapter reports each as `ADDED` or `MODIFIED`. */
export interface RepoBackup {
  readonly profile?: Profile;
}

/** One value or destination the repo's copy and this machine's disagree on.
 * `repo` and `machine` are the two sides, in that order. */
export interface BackupQuestion {
  readonly profile: string;
  readonly kind: "value" | "destination";
  readonly key: string;
  readonly repo: string;
  readonly machine: string;
}

/** The first backup's files to write and its questions. */
export interface FirstBackupPlan {
  readonly paths: readonly string[];
  readonly questions: readonly BackupQuestion[];
}

/** Which side's value a question keeps. */
export type BackupSide = "repo" | "machine";

/** One file the first backup writes, path relative to the repo root. */
export interface BackupFile {
  readonly path: string;
  readonly text: string;
}

/** The merged profile, the unchanged record and the layer files to write. */
export interface FirstBackupWrites {
  readonly profile: Profile;
  readonly record: MachineRecord;
  readonly files: readonly BackupFile[];
}

function profilePath(name: string): string {
  return `${PROFILES_FOLDER}/${name}${JSON_EXTENSION}`;
}

function recordPath(name: string): string {
  return `${MACHINES_FOLDER}/${name}${JSON_EXTENSION}`;
}

function layerPath(folder: string, name: string, path: string): string {
  return `${folder}/${name}/${path}`;
}

function byPath(
  a: { readonly path: string },
  b: { readonly path: string },
): number {
  if (a.path < b.path) {
    return -1;
  }
  return a.path > b.path ? 1 : 0;
}

function questionKey(question: CopyQuestion): string {
  return `${question.kind}:${question.key}`;
}

/** One question with its two sides, repo first. `mergeProfileCopies` gives a
 * question two distinct values, since it merges exactly two copies. */
function backupQuestion(
  profile: string,
  question: CopyQuestion,
): BackupQuestion | undefined {
  const [repo, machine] = question.choices;
  if (repo === undefined || machine === undefined) {
    return undefined;
  }
  return { profile, kind: question.kind, key: question.key, repo, machine };
}

function mergedProfile(
  local: LocalBackup,
  repo: RepoBackup,
  answers: ReadonlyMap<string, BackupSide>,
): Profile {
  if (repo.profile === undefined) {
    return local.profile;
  }

  const merged = mergeProfileCopies([repo.profile, local.profile]);
  const values: [string, string][] = [...Object.entries(merged.profile.values)];
  const destinations: [string, string][] = [
    ...Object.entries(merged.profile.destinations),
  ];
  for (const question of merged.questions) {
    const side =
      answers.get(questionKey(question)) === "machine"
        ? question.choices[1]
        : question.choices[0];
    if (side === undefined) {
      continue;
    }
    if (question.kind === "value") {
      values.push([question.key, side]);
    } else {
      destinations.push([question.key, side]);
    }
  }

  return {
    ...merged.profile,
    values: Object.fromEntries(values),
    destinations: Object.fromEntries(destinations),
  };
}

/**
 * The first backup's plan: every repo path it writes (the record, the profile
 * and every file in both layer folders) and one question per value or
 * destination the repo's profile and this machine's disagree on.
 */
export function planFirstBackup(
  local: LocalBackup,
  repo: RepoBackup,
): FirstBackupPlan {
  const questions: BackupQuestion[] = [];
  const profile = repo.profile;
  if (profile !== undefined) {
    const merged = mergeProfileCopies([profile, local.profile]);
    for (const question of merged.questions) {
      const asked = backupQuestion(local.profile.name, question);
      if (asked !== undefined) {
        questions.push(asked);
      }
    }
  }

  const paths = [
    profilePath(local.profile.name),
    recordPath(local.record.name),
    ...local.profileLayer.map((file) =>
      layerPath(PROFILES_FOLDER, local.profile.name, file.path),
    ),
    ...local.machineLayer.map((file) =>
      layerPath(MACHINES_FOLDER, local.record.name, file.path),
    ),
  ].sort();

  // Contract: asked once per key, in key order.
  questions.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { paths, questions };
}

/**
 * The first backup's writes: the merged profile, the record unchanged, and
 * every file in both layer folders, this machine's text over the repo's.
 */
export function firstBackupWrites(
  local: LocalBackup,
  repo: RepoBackup,
  answers: ReadonlyMap<string, BackupSide>,
): FirstBackupWrites {
  const files: BackupFile[] = [];
  for (const file of local.profileLayer) {
    files.push({
      path: layerPath(PROFILES_FOLDER, local.profile.name, file.path),
      text: file.text,
    });
  }
  for (const file of local.machineLayer) {
    files.push({
      path: layerPath(MACHINES_FOLDER, local.record.name, file.path),
      text: file.text,
    });
  }

  return {
    profile: mergedProfile(local, repo, answers),
    record: local.record,
    files: files.sort(byPath),
  };
}
