export PATHEXT="$PATHEXT:.BAT:.CMD"
# Add your custom folder to PATH
export PATH=$PATH:/c/MakuCustomAlias

for f in /c/MakuCustomAlias/*.bat; do
  name=$(basename "$f" .bat)
  alias "$name"="$f"
done

# alias vs='vs.bat'