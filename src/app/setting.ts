/**
 * `mksync setting list` (contract "mksync setting", `mksync setting list`):
 * load the record and the snapshot as `status` does, pick the profile, and
 * print the settings the layers above the base set. Reads only: it never
 * writes or asks.
 */

import { readOrigin } from "../adapters/git.ts";
import { buildSnapshot } from "../adapters/snapshot.ts";
import type { Layers } from "../adapters/snapshot.ts";
import { readStore } from "../adapters/store.ts";
import { readVisibility } from "../adapters/visibility.ts";
import type { RunCommand, SettingListCommand } from "../cli/parse.ts";
import type { ConfigV2, Os } from "../core/config/types.ts";
import { selectEntries } from "../core/layers/select.ts";
import { scopeFor } from "../core/plan/pick.ts";
import {
  renderSettingList,
  settingListHeader,
  settingRows,
} from "../core/plan/settings.ts";
import type {
  RepoVisibility,
  SettingListTarget,
} from "../core/plan/settings.ts";
import { failure } from "./export.ts";
import type { Result } from "./export.ts";
import { writeLines } from "./terminal.ts";

/** What `mksync setting list` reads from the run. */
export interface SettingListInput {
  readonly repoRoot: string;
  readonly config: ConfigV2;
  readonly os: Os;
  readonly home: string;
  readonly state: string;
  readonly layers: Layers;
}

/** The snapshot is read as the import check reads it, as `status` does. */
const READ_COMMAND: RunCommand = {
  kind: "run",
  command: "import",
  force: false,
  preview: false,
  check: true,
  resetValues: false,
  yes: false,
  only: [],
};

type Picked =
  | {
      readonly ok: true;
      readonly layers: Layers;
      readonly target: SettingListTarget;
    }
  | { readonly ok: false; readonly result: Result };

/**
 * The layers the listing reads: `--profile` swaps in that profile with no
 * machine layer; else the record's profile and machine; no record, the OS
 * layer only.
 */
function pickLayers(
  command: SettingListCommand,
  input: SettingListInput,
): Picked {
  const { layers } = input;
  if (command.profile === undefined) {
    if (layers.record === undefined || layers.machine === undefined) {
      return { ok: true, layers, target: { kind: "none" } };
    }
    return {
      ok: true,
      layers,
      target: {
        kind: "record",
        machine: layers.machine,
        profile: layers.record.profile,
      },
    };
  }
  // shortcut: only the profiles this machine holds; once the repo is private
  // `--profile` may name every profile in the repo (contract "mksync setting
  // list"), which needs the repo store's layer roots.
  const store = readStore(input.state, input.repoRoot, input.config);
  if (!store.ok) {
    return {
      ok: false,
      result: failure(store.error.message, store.error.code),
    };
  }
  const profile = store.value.profiles.find(
    (held) => held.name === command.profile,
  );
  if (profile === undefined) {
    return {
      ok: false,
      result: failure(`ERROR: unknown profile ${command.profile}`, 2),
    };
  }
  return {
    ok: true,
    layers: { location: layers.location, profile },
    target: { kind: "profile", profile: profile.name },
  };
}

async function repoVisibility(repoRoot: string): Promise<RepoVisibility> {
  const visibility = await readVisibility(
    await readOrigin(repoRoot),
    process.env,
  );
  return visibility === "private" ? "private" : "public";
}

export async function runSettingList(
  command: SettingListCommand,
  input: SettingListInput,
): Promise<Result> {
  const picked = pickLayers(command, input);
  if (!picked.ok) {
    return picked.result;
  }
  const snapshot = await buildSnapshot(
    input.repoRoot,
    input.config,
    input.os,
    input.home,
    READ_COMMAND,
    process.cwd(),
    process.env,
    picked.layers,
  );
  const selected = selectEntries(
    snapshot.config,
    scopeFor(snapshot),
    new Set(snapshot.repoFiles.keys()),
  );
  if (!selected.ok) {
    return failure(selected.error.message, selected.error.code);
  }
  const rows = settingRows(selected.value, snapshot.repoFiles, input.os);
  const lines = renderSettingList(
    settingListHeader(picked.target),
    rows,
    await repoVisibility(input.repoRoot),
  );
  return { code: 0, stdout: writeLines(lines), stderr: "" };
}
