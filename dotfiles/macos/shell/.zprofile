# ~/.zprofile: login shell setup on macOS.

# Homebrew: Apple silicon installs to /opt/homebrew, Intel to /usr/local.
if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
fi

# mksync and other user tools.
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
