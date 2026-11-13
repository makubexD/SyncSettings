import { hostname as hostName } from "node:os";
import type { Os } from "../core/config/types.ts";
import type { MachineIdentity } from "../core/machine/check.ts";

/** The Windows domain `USERDNSDOMAIN` holds, lowercased, or `null` when it is
 * missing or empty. */
function windowsDomain(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const domain = env.USERDNSDOMAIN;
  return domain === undefined || domain === "" ? null : domain.toLowerCase();
}

/** Decision 2: `SYNC_DOMAIN` when set, with an empty value meaning no domain;
 * otherwise the Windows domain, and `null` on the other systems. */
function domainOf(
  env: Readonly<Record<string, string | undefined>>,
  os: Os,
): string | null {
  const override = env.SYNC_DOMAIN;
  if (override !== undefined) {
    return override === "" ? null : override;
  }
  return os === "windows" ? windowsDomain(env) : null;
}

/**
 * What the scan reads about this machine (decision 8's check): its OS, its
 * hostname and its domain. Decision 2: `SYNC_HOSTNAME` and `SYNC_DOMAIN`
 * replace what the scan reads, so shared cases print the same on every
 * runner; the hostname is lowercased either way.
 */
export function readIdentity(
  env: Readonly<Record<string, string | undefined>>,
  os: Os,
): MachineIdentity {
  const hostname = (env.SYNC_HOSTNAME ?? hostName()).toLowerCase();
  return { os, hostname, domain: domainOf(env, os) };
}
