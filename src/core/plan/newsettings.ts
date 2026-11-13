import type { Profile } from "../config/profile.ts";
import type { Os } from "../config/types.ts";
import type { LayerName } from "../layers/select.ts";
import { OS_TITLES } from "./groups.ts";

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
    words: "all machines",
  };
  const osMachines: NewSettingChoice = {
    number: 2,
    layer: "os",
    words: `${OS_TITLES[os]} machines`,
  };
  const profileLayer: NewSettingChoice = {
    number: 3,
    layer: "profile",
    words: `profile ${record.profile}`,
  };
  const thisMachine: NewSettingChoice = {
    number: 4,
    layer: "machine",
    words: "this machine",
  };
  return {
    choices: [allMachines, osMachines, profileLayer, thisMachine],
    suggestion:
      record.profile === PERSONAL_PROFILE ? allMachines : profileLayer,
  };
}

/**
 * The layer the profile's destinations stores for a key path, if any. A value
 * that isn't a layer is treated as no destination.
 */
export function storedDestination(
  profile: Profile | undefined,
  path: string,
): LayerName | undefined {
  const stored = profile?.destinations[path];
  return LAYER_NAMES.find((layer) => layer === stored);
}

/**
 * The profile after answering where a new setting goes. An array item stores
 * its path in `destinations` so the next item there isn't asked; a new key's
 * answer isn't stored, since the key now has a layer. The input is never
 * mutated.
 */
export function storeDestination(
  profile: Profile,
  path: string,
  layer: LayerName,
  kind: "key" | "item",
): Profile {
  if (kind === "key") {
    return profile;
  }
  return {
    ...profile,
    destinations: { ...profile.destinations, [path]: layer },
  };
}
