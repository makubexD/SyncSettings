import { describe, expect, test } from "bun:test";
import type { Profile } from "../config/profile.ts";
import {
  firstBackupWrites,
  planFirstBackup,
} from "./backup.ts";
import type {
  BackupSide,
  LayerFile,
  LocalBackup,
  RepoBackup,
} from "./backup.ts";
import type { MachineRecord } from "./record.ts";

const PROFILE_NAME = "work-1";

const MACHINE_NAME = "wk1-laptop";

const HOME_KEY = "<HOME>";

const HOME_HERE = "/home/user";

const HOME_REPO = "/home/jane";

/** Sorts after `<HOME>`, though the repo copy lists it first. */
const EMAIL_KEY = "<YOUR_EMAIL>";

const EMAIL_HERE = "jane.doe@work1.example.com";

const EMAIL_REPO = "jane@work1.example.com";

const PROFILE_FILE = "profiles/work-1.json";

const RECORD_FILE = "machines/wk1-laptop.json";

const PROFILE_LAYER_PATH = "git/.gitconfig.local";

const MACHINE_LAYER_PATH = "vscode/settings.json";

const PROFILE_LAYER_FILE: LayerFile = {
  path: PROFILE_LAYER_PATH,
  text: "[user]\n\tname = <YOUR_NAME>\n",
};

const MACHINE_LAYER_FILE: LayerFile = {
  path: MACHINE_LAYER_PATH,
  text: '{"editor.fontSize": 15}\n',
};

const PROFILE_LAYER_REPO_PATH = `profiles/${PROFILE_NAME}/${PROFILE_LAYER_PATH}`;

const MACHINE_LAYER_REPO_PATH = `machines/${MACHINE_NAME}/${MACHINE_LAYER_PATH}`;

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: PROFILE_NAME,
    modules: [],
    values: {},
    destinations: {},
    retired: false,
    ...overrides,
  };
}

function makeLocal(overrides: Partial<LocalBackup> = {}): LocalBackup {
  return {
    profile: makeProfile({ modules: ["git"], values: { [HOME_KEY]: HOME_HERE } }),
    profileLayer: [PROFILE_LAYER_FILE],
    record: makeRecord(),
    machineLayer: [MACHINE_LAYER_FILE],
    ...overrides,
  };
}

function makeRecord(): MachineRecord {
  return {
    name: MACHINE_NAME,
    profile: PROFILE_NAME,
    os: "linux",
    hostname: MACHINE_NAME,
    domain: null,
    claude: "none",
    pullOnly: false,
    modules: { add: [], remove: [] },
    values: {},
    replaced: [],
    retired: false,
  };
}

function makeRepo(overrides: Partial<RepoBackup> = {}): RepoBackup {
  return { ...overrides };
}

function makeAnswers(
  entries: readonly (readonly [string, BackupSide])[] = [],
): ReadonlyMap<string, BackupSide> {
  return new Map(entries);
}

describe("planFirstBackup", () => {
  test("writes every local file when the repo holds nothing", () => {
    // Arrange
    const local = makeLocal();

    // Act
    const plan = planFirstBackup(local, makeRepo());

    // Assert
    expect(plan.paths).toEqual([
      RECORD_FILE,
      MACHINE_LAYER_REPO_PATH,
      PROFILE_FILE,
      PROFILE_LAYER_REPO_PATH,
    ]);
    expect(plan.questions).toEqual([]);
  });

  test("joins the modules with no questions when the repo's profile agrees", () => {
    // Arrange
    const local = makeLocal({
      profile: makeProfile({
        modules: ["claude"],
        values: { [HOME_KEY]: HOME_HERE },
      }),
    });
    const repo = makeRepo({
      profile: makeProfile({
        modules: ["git"],
        values: { [HOME_KEY]: HOME_HERE },
      }),
    });

    // Act
    const plan = planFirstBackup(local, repo);

    // Assert
    expect(plan.questions).toEqual([]);
  });

  test("asks about a differing value with the repo's side first", () => {
    // Arrange
    const local = makeLocal();
    const repo = makeRepo({
      profile: makeProfile({ values: { [HOME_KEY]: HOME_REPO } }),
    });

    // Act
    const plan = planFirstBackup(local, repo);

    // Assert
    expect(plan.questions).toEqual([
      {
        profile: PROFILE_NAME,
        kind: "value",
        key: HOME_KEY,
        repo: HOME_REPO,
        machine: HOME_HERE,
      },
    ]);
  });

  test("asks about a differing destination with the repo's side first", () => {
    // Arrange
    const local = makeLocal({
      profile: makeProfile({ destinations: { [HOME_KEY]: "machine" } }),
    });
    const repo = makeRepo({
      profile: makeProfile({ destinations: { [HOME_KEY]: "profile" } }),
    });

    // Act
    const plan = planFirstBackup(local, repo);

    // Assert
    expect(plan.questions).toEqual([
      {
        profile: PROFILE_NAME,
        kind: "destination",
        key: HOME_KEY,
        repo: "profile",
        machine: "machine",
      },
    ]);
  });

  test("should ask in key order when several keys differ", () => {
    // Arrange
    const local = makeLocal({
      profile: makeProfile({
        values: { [EMAIL_KEY]: EMAIL_HERE, [HOME_KEY]: HOME_HERE },
      }),
    });
    const repo = makeRepo({
      profile: makeProfile({
        values: { [EMAIL_KEY]: EMAIL_REPO, [HOME_KEY]: HOME_REPO },
      }),
    });

    // Act
    const plan = planFirstBackup(local, repo);

    // Assert
    expect(plan.questions.map((question) => question.key)).toEqual([
      HOME_KEY,
      EMAIL_KEY,
    ]);
  });
});

describe("firstBackupWrites", () => {
  test("writes this machine's profile as it is when the repo has none", () => {
    // Arrange
    const local = makeLocal();

    // Act
    const writes = firstBackupWrites(local, makeRepo(), makeAnswers());

    // Assert
    expect(writes.profile).toEqual(local.profile);
    expect(writes.record).toEqual(local.record);
    expect(writes.files).toEqual([
      { path: MACHINE_LAYER_REPO_PATH, text: MACHINE_LAYER_FILE.text },
      { path: PROFILE_LAYER_REPO_PATH, text: PROFILE_LAYER_FILE.text },
    ]);
  });

  test("joins the modules when the repo's profile agrees", () => {
    // Arrange
    const local = makeLocal({
      profile: makeProfile({ modules: ["claude"] }),
    });
    const repo = makeRepo({ profile: makeProfile({ modules: ["git"] }) });

    // Act
    const writes = firstBackupWrites(local, repo, makeAnswers());

    // Assert
    expect(writes.profile.modules).toEqual(["git", "claude"]);
  });

  test("keeps the repo's value when the answer is repo", () => {
    // Arrange
    const local = makeLocal();
    const repo = makeRepo({
      profile: makeProfile({ values: { [HOME_KEY]: HOME_REPO } }),
    });

    // Act
    const writes = firstBackupWrites(
      local,
      repo,
      makeAnswers([[`value:${HOME_KEY}`, "repo"]]),
    );

    // Assert
    expect(writes.profile.values).toEqual({ [HOME_KEY]: HOME_REPO });
  });

  test("keeps this machine's value when the answer is machine", () => {
    // Arrange
    const local = makeLocal();
    const repo = makeRepo({
      profile: makeProfile({ values: { [HOME_KEY]: HOME_REPO } }),
    });

    // Act
    const writes = firstBackupWrites(
      local,
      repo,
      makeAnswers([[`value:${HOME_KEY}`, "machine"]]),
    );

    // Assert
    expect(writes.profile.values).toEqual({ [HOME_KEY]: HOME_HERE });
  });

  test("keeps the repo's value when the question is unanswered", () => {
    // Arrange
    const local = makeLocal();
    const repo = makeRepo({
      profile: makeProfile({ values: { [HOME_KEY]: HOME_REPO } }),
    });

    // Act
    const writes = firstBackupWrites(local, repo, makeAnswers());

    // Assert
    expect(writes.profile.values).toEqual({ [HOME_KEY]: HOME_REPO });
  });

  test("fills an answered destination from this machine", () => {
    // Arrange
    const local = makeLocal({
      profile: makeProfile({ destinations: { [HOME_KEY]: "machine" } }),
    });
    const repo = makeRepo({
      profile: makeProfile({ destinations: { [HOME_KEY]: "profile" } }),
    });

    // Act
    const writes = firstBackupWrites(
      local,
      repo,
      makeAnswers([[`destination:${HOME_KEY}`, "machine"]]),
    );

    // Assert
    expect(writes.profile.destinations).toEqual({ [HOME_KEY]: "machine" });
  });

  test("should write every layer file from this machine", () => {
    // Arrange
    const local = makeLocal();

    // Act
    const writes = firstBackupWrites(local, makeRepo(), makeAnswers());

    // Assert
    expect(writes.files).toEqual([
      { path: MACHINE_LAYER_REPO_PATH, text: MACHINE_LAYER_FILE.text },
      { path: PROFILE_LAYER_REPO_PATH, text: PROFILE_LAYER_FILE.text },
    ]);
  });
});
