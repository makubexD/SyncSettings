export PATHEXT="$PATHEXT:.BAT:.CMD"
# Add your custom folder to PATH
export PATH=$PATH:/c/MakuCustomAlias

for f in /c/MakuCustomAlias/*.bat; do
  name=$(basename "$f" .bat)
  alias "$name"="$f"
done

# alias vs='vs.bat'

# Machine-only setup that SyncSettings never syncs.
[ -f "$HOME/.bashrc.local" ] && . "$HOME/.bashrc.local"
# W5 test
