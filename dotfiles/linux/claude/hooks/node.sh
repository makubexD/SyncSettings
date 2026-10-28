#!/usr/bin/env bash
# Run node for Claude Code hooks without hard-coding an nvm version.
# Order: nvm default alias (when it names a version) -> newest nvm install -> node on PATH (e.g. /usr/bin/node).
# Doesn't source nvm.sh, because that is too slow for a hook.

versions=${NVM_DIR:-$HOME/.nvm}/versions/node
alias=$(cat "${NVM_DIR:-$HOME/.nvm}/alias/default" 2>/dev/null)
alias=${alias#v}

pick=""
if [[ $alias =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
    pick=$(ls -1 "$versions" 2>/dev/null | grep -E "^v${alias//./\\.}(\.|$)" | sort -V | tail -1)
fi
[[ -z $pick ]] && pick=$(ls -1 "$versions" 2>/dev/null | sort -V | tail -1)

if [[ -n $pick && -x $versions/$pick/bin/node ]]; then
    exec "$versions/$pick/bin/node" "$@"
fi

if command -v node >/dev/null 2>&1; then
    exec node "$@"
fi

echo "node.sh: no node found on PATH or under $versions" >&2
exit 1
