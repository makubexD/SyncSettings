#!/usr/bin/env bash
# Validate sync-config.json: required repoPath/localPath, duplicate repoPaths,
# platform values and repoPath prefixes, plus the type, dir and inside-a-dir rules.
# Prints "<config-file>: OK" when clean; on invalid entries it names each
# offending repoPath and exits 1.
# Usage: scripts/ci/check-config.sh [config-file]
set -euo pipefail

CONFIG=${1:-sync-config.json}

if [[ ! -e $CONFIG ]]; then
    printf 'ERROR: no such file: %s\n' "$CONFIG" >&2
    exit 2
fi

jq -r --arg file "$CONFIG" '
def bad_keys:
    (.keys | type) as $t
    | if $t != "array" then true
      elif (.keys | length) == 0 then true
      else ([.keys[] | select(type != "string")] | length) > 0
      end;
(.files | map(select(.type == "dir") | .repoPath | rtrimstr("/"))) as $dirs
| [
  (.files[] | select((.repoPath // "") == "" or (.type != "dconf" and (.localPath // "") == "")) | .repoPath // "<missing repoPath>"),
  (.files | group_by(.repoPath)[] | select(length > 1) | .[0].repoPath | select(. != null and . != "")),
  (.files[] | select((.platform // "") | IN("common", "windows", "linux") | not) | .repoPath // "<missing repoPath>"),
  (.files[] | select(.platform == "linux") | select((.repoPath // "") | startswith("dotfiles/linux/") | not) | .repoPath // "<missing repoPath>"),
  (.files[] | select(.platform == "common") | select((.repoPath // "") | startswith("dotfiles/common/") | not) | .repoPath // "<missing repoPath>"),
  (.files[] | select(.platform == "windows") | select((.repoPath // "") | startswith("dotfiles/windows/") | not) | .repoPath // "<missing repoPath>"),
  (.files[] | select(.platform == "common") | select((.localPath // "") | startswith("~/") | not) | .repoPath // "<missing repoPath>"),
  (.files[] | select(has("type") and ((.type == "file" or .type == "dir" or .type == "dconf") | not)) | .repoPath // "<missing repoPath>"),
  (.files[] | select(.type == "dir") | select(has("sanitizeRules") or has("detectLinkedPaths")) | .repoPath // "<missing repoPath>"),
  (.files[] | .repoPath as $p | select(any($dirs[]; . as $d | ($p // "") | startswith($d + "/"))) | $p),
  (.files[] | select(.type == "dconf") | select(
      (.platform // "") != "linux"
      or has("localPath") or has("sanitizeRules") or has("detectLinkedPaths")
      or (((.path // "") | test("^(/[A-Za-z0-9._-]+)+/$")) | not)
      or ((.path // "") | contains("/../"))
  ) | .repoPath // "<missing repoPath>"),
  (.files[] | select(.type != "dconf") | select(has("path") or has("keys")) | .repoPath // "<missing repoPath>"),
  (.files[] | select(has("keys")) | select(bad_keys) | .repoPath // "<missing repoPath>")
] | unique as $bad
| if ($bad | length) == 0
  then "\($file): OK"
  else ($bad[]), ("\($file): invalid entries above\n" | halt_error(1))
  end
' "$CONFIG"
