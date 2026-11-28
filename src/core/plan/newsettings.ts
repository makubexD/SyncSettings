import type { Profile } from "../config/profile.ts";
import type { Os } from "../config/types.ts";
import type { LayerName } from "../layers/select.ts";
import { OS_TITLES } from "./groups.ts";
import type { NewSettingLine } from "./types.ts";

/** The profile whose new settings go to the base layer by default. */
const PERSONAL_PROFILE = "personal";

/** Every layer name a stored destination may hold. */
const LAYER_NAMES: readonly LayerName[] = ["base", "os", "profile", "machine"];

/** One numbered answer to "Where does it go?" (contract "New settings"). */
export interface NewSettingChoice {
  readonly number: 1 | 2 | 3 | 4;
  readonly layer: LayerName;
  readonly words: string;
}

/** The four choices and the one an empty answer takes. */
export interface NewSettingQuestion {
  readonly choices: readonly NewSettingChoice[];
  readonly suggestion: NewSettingChoice;
}

/** A layer's group words, as the questions and `mksync setting list` print
 * them: `all machines`, `<OS> machines`, `profile <p>`, `this machine`. */
export function layerWords(layer: LayerName, os: Os, profile: string): string {
  switch (layer) {
    case "base":
      return "all machines";
    case "os":
      return `${OS_TITLES[os]} machines`;
    case "profile":
      return `profile ${profile}`;
    case "machine":
      return "this machine";
    default: {
      const unhandled: never = layer;
      throw new Error(`Unhandled layer: ${String(unhandled)}`);
    }
  }
}

/**
 * The question a new setting asks with a record: the four layers in order and
 * the suggestion of decision 4. Without a record there is no profile or
 * machine layer, so there is no question.
 */
export function newSettingChoices(
  record: { readonly profile: string } | undefined,
  os: Os,
): NewSettingQuestion | undefined {
  if (record === undefined) {
    return undefined;
  }
  const allMachines: NewSettingChoice = {
    number: 1,
    layer: "base",
    words: layerWords("base", os, record.profile),
  };
  const osMachines: NewSettingChoice = {
    number: 2,
    layer: "os",
    words: layerWords("os", os, record.profile),
  };
  const profileLayer: NewSettingChoice = {
    number: 3,
    layer: "profile",
    words: layerWords("profile", os, record.profile),
  };
  const thisMachine: NewSettingChoice = {
    number: 4,
    layer: "machine",
    words: layerWords("machine", os, record.profile),
  };
  return {
    choices: [allMachines, osMachines, profileLayer, thisMachine],
    suggestion:
      record.profile === PERSONAL_PROFILE ? allMachines : profileLayer,
  };
}

/**
 * A destination's key: the module, the entry's file after its module folder,
 * and the key path, so the same path in two files is two destinations
 * (contract "New settings (program only)", The answer is stored).
 */
export function destinationKey(
  module: string,
  file: string,
  path: string,
): string {
  return `${module} ${file}: ${path}`;
}

/** The destination key one new setting is stored and looked up by. */
export function settingKey(setting: NewSettingLine): string {
  return destinationKey(setting.module, setting.file, setting.path);
}

/**
 * The new settings grouped by destination key, in the order each key first
 * appears; each group holds the indices of the settings that share it, so a
 * path's items are asked once and one answer covers them all.
 */
export function settingGroups(
  settings: readonly NewSettingLine[],
): readonly (readonly number[])[] {
  const byKey = new Map<string, number[]>();
  settings.forEach((setting, index) => {
    const key = settingKey(setting);
    const group = byKey.get(key);
    if (group === undefined) {
      byKey.set(key, [index]);
      return;
    }
    group.push(index);
  });
  return [...byKey.values()];
}

/** The answers a list of choices gives, destination key to layer slot. The
 * lists run parallel to the new settings; a group's answer repeats for each of
 * its settings and stores the one key. */
export function answersOf(
  settings: readonly NewSettingLine[],
  choices: readonly NewSettingChoice[],
): ReadonlyMap<string, LayerName> {
  const answers = new Map<string, LayerName>();
  settings.forEach((setting, index) => {
    const choice = choices[index];
    if (choice !== undefined) {
      answers.set(settingKey(setting), choice.layer);
    }
  });
  return answers;
}

/** Every new setting taking the suggestion, which is what `--yes` answers. */
export function suggestionAnswers(
  settings: readonly NewSettingLine[],
  question: NewSettingQuestion,
): ReadonlyMap<string, LayerName> {
  return answersOf(
    settings,
    settings.map(() => question.suggestion),
  );
}

/**
 * The stored destinations that belong to one entry, keyed by bare key path: the
 * split looks one path up in the file it is splitting, so a destination stored
 * for another file's same path stays out.
 */
export function entryDestinations(
  destinations: ReadonlyMap<string, LayerName>,
  module: string,
  file: string,
): ReadonlyMap<string, LayerName> {
  const prefix = `${module} ${file}: `;
  const scoped = new Map<string, LayerName>();
  for (const [key, layer] of destinations) {
    if (key.startsWith(prefix)) {
      scoped.set(key.slice(prefix.length), layer);
    }
  }
  return scoped;
}

/**
 * The layer the profile's destinations stores for a destination key, if any. A
 * value that isn't a layer is treated as no destination.
 */
export function storedDestination(
  profile: Profile | undefined,
  key: string,
): LayerName | undefined {
  const stored = profile?.destinations[key];
  return LAYER_NAMES.find((layer) => layer === stored);
}

/**
 * The profile after answering where a new setting goes. An array item stores
 * its destination key in `destinations` so the next item there isn't asked; a
 * new key's answer isn't stored, since the key now has a layer. The input is
 * never mutated.
 */
export function storeDestination(
  profile: Profile,
  key: string,
  layer: LayerName,
  kind: "key" | "item",
): Profile {
  if (kind === "key") {
    return profile;
  }
  return {
    ...profile,
    destinations: { ...profile.destinations, [key]: layer },
  };
}
