local wezterm = require 'wezterm'
local config = {}

config.font = wezterm.font 'JetBrainsMono Nerd Font'
config.font_size = 13.0

config.color_scheme = 'Catppuccin Mocha'

config.window_padding = {
  left = 12,
  right = 12,
  top = 8,
  bottom = 8,
}

config.cursor_blink_rate = 500
config.default_cursor_style = 'BlinkingBar'
config.hide_tab_bar_if_only_one_tab = true

return config
