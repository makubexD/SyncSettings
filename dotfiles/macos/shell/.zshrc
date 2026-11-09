# ~/.zshrc: interactive zsh on macOS, the Mac counterpart of the Linux .bashrc.

# History: shared across sessions, no duplicates or space-prefixed lines.
HISTFILE=~/.zsh_history
HISTSIZE=1000
SAVEHIST=2000
setopt APPEND_HISTORY HIST_IGNORE_DUPS HIST_IGNORE_SPACE

# BSD ls colours come from CLICOLOR, not --color=auto.
export CLICOLOR=1
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

autoload -Uz compinit && compinit

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
[ -s "$HOME/.config/opencode/omniroute.env" ] && \. "$HOME/.config/opencode/omniroute.env"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

alias cproj='cd "$HOME/WorkspaceMaku/MakuReposStable"'

command -v fzf > /dev/null 2>&1 && source <(fzf --zsh)
command -v zoxide > /dev/null 2>&1 && eval "$(zoxide init zsh)"
command -v starship > /dev/null 2>&1 && eval "$(starship init zsh)"
