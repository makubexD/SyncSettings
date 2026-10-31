#!/usr/bin/env bash
# Validate a Claude Code settings file: every enabled plugin names a declared
# marketplace, and every marketplace is a github repo with a safe ref, so
# bootstrap can add it.
# Prints "<file>: OK" when clean; on invalid entries it names each problem and
# exits 1.
# Usage: scripts/ci/check-plugins.sh [settings-file]
set -euo pipefail

SETTINGS=${1:-dotfiles/linux/claude/settings.json}

if [[ ! -e $SETTINGS ]]; then
    printf 'ERROR: no such file: %s\n' "$SETTINGS" >&2
    exit 2
fi

# The patterns use \A and \z, not ^ and $: jq's $ matches before a trailing
# newline, so "a/b\n" would otherwise pass as a repo.
jq -r --arg file "$SETTINGS" '
(.extraKnownMarketplaces // {}) as $marks
| [
  (
    .enabledPlugins // {}
    | to_entries[]
    | .key as $key
    | if ($key | test("\\A[^@]+@[^@]+\\z") | not)
      then "enabledPlugins \($key | tojson): want <plugin>@<marketplace>"
      else ($key | sub(".*@"; "")) as $market
      | if $marks | has($market)
        then empty
        else "enabledPlugins \($key | tojson): marketplace \($market | tojson) is not declared"
        end
      end
  ),
  (
    .extraKnownMarketplaces // {}
    | to_entries[]
    | .key as $name
    | (.value.source // {}) as $src
    | if $src.source != "github" then
        "extraKnownMarketplaces \($name | tojson): source.source is \($src.source | tojson), want \"github\""
      else empty end,
      if (($src.repo // "" | tostring) | test("\\A[A-Za-z0-9_.<>-]+/[A-Za-z0-9_.-]+\\z") | not) then
        "extraKnownMarketplaces \($name | tojson): repo \($src.repo // null | tojson) is not owner/name"
      else empty end,
      if $src.ref != null and (($src.ref | tostring) | test("\\A[A-Za-z0-9][A-Za-z0-9._/-]*\\z") | not) then
        "extraKnownMarketplaces \($name | tojson): ref \($src.ref | tojson) is not a safe ref"
      else empty end
  )
] | unique as $bad
| if ($bad | length) == 0
  then "\($file): OK"
  else ($bad[]), ("\($file): invalid entries above\n" | halt_error(1))
  end
' "$SETTINGS"
