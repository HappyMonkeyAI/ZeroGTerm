---
version: alpha
name: ZeroG Terminal
description: A focused dark terminal workspace where persistent sessions, AI assistance, and operator control are clear and calm.
colors:
  primary: "#0A0C10"
  secondary: "#0F1218"
  tertiary: "#7AA2F7"
  neutral: "#D8DEE9"
  muted: "#697386"
  border: "#202630"
  success: "#9ECE6A"
  warning: "#E0AF68"
  danger: "#F7768E"
typography:
  display:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 1.25rem
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body-md:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: "JetBrains Mono, Iosevka, monospace"
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 0.6875rem
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0.06em"
rounded:
  sm: 4px
  md: 6px
  lg: 10px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  app-shell:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    typography: "{typography.body-md}"
  session-sidebar:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  session-item:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  session-item-active:
    backgroundColor: "{colors.border}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  terminal-pane:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  pane-divider:
    backgroundColor: "{colors.border}"
    size: 1px
  accent-action:
    backgroundColor: "{colors.tertiary}"
    textColor: "#071014"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  secondary-action:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  command-palette:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  approval-warning:
    backgroundColor: "#332A12"
    textColor: "{colors.warning}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  connection-healthy:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs}"
  connection-error:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: "{spacing.xs}"
---

## Overview

ZeroG Terminal should feel like a calm, high-signal control surface for active technical work. The visual language is dark, compact, keyboard-first, and information-dense without becoming noisy.

The terminal remains the primary surface. AI actions, session state, voice feedback, and approval prompts should support the operator rather than compete with command output.

## Colors

- **Primary (#0B0F14):** Near-black blue background for terminal panes and the application canvas.
- **Secondary (#111923):** Slightly elevated surfaces for the session sidebar, command palette, and controls.
- **Tertiary (#6EE7F9):** Cyan interaction accent used sparingly for focus, links, and primary actions.
- **Neutral (#E6EDF3):** High-contrast foreground text and important terminal metadata.
- **Muted (#9FB0C0):** Secondary labels and inactive session information.
- **Border (#263445):** Pane dividers and subtle structural boundaries.
- **Success (#8BE28B):** Connected, completed, or healthy state.
- **Warning (#FFD166):** Pending approval, degraded connection, or attention required.
- **Danger (#FF7B72):** Failure and destructive-action state.

Do not use color as the only state indicator. Pair status colors with text, icons, or shape changes.

## Typography

Use a proportional sans-serif for application chrome and a monospaced face for terminal content, paths, commands, session names, and technical identifiers. Favor readable line height and stable alignment over decorative typography.

## Layout

- The terminal canvas is the dominant surface; chrome must recede behind it.
- Use a narrow icon rail, a compact session drawer, and a thin window/command bar rather than a dashboard header.
- The workspace is a pane tree with stack, vertical split, horizontal split, and grid layouts.
- Pane dividers are one-pixel structural lines; focus is shown by a restrained accent edge, never a glowing card.
- Session overview is a transient thumbnail grid opened from the top bar, rail, or `Ctrl+Shift+O`.
- Keyboard navigation must have a mouse-equivalent path: `Ctrl+Shift+N` creates a local terminal, `Ctrl+Shift+L` toggles a split, and `Ctrl+Shift+O` opens overview.
- Session creation and SSH connection use compact forms; routine switching uses the drawer or overview, not a large modal dashboard.

## Elevation & Depth

Use contrast and borders rather than heavy shadows. A command palette or approval prompt may use a restrained elevation treatment, but terminal panes should remain visually flat and uninterrupted.

## Shapes

Use small radii for controls and pane surfaces. Large rounded cards are reserved for transient overlays such as the command palette or AI approval surface. Avoid excessive pill-shaped controls because ZeroG is a technical workspace, not a marketing dashboard.

## Components

### Session sidebar

Shows local and remote sessions in a compact drawer beside a narrow icon rail. Each row exposes a concise name, host/path, and connection state. The active session uses a quiet filled surface and edge marker; status is never conveyed by color alone.

### Session overview

The overview is a transient, keyboard-accessible thumbnail surface inspired by Tilix session navigation and window overviews. Thumbnails show enough terminal texture to distinguish workspaces without competing with live output. It provides direct actions for creating local or SSH sessions.

### Terminal pane

The terminal is the highest-priority surface. Do not place persistent AI chrome or notes beside the terminal at equal visual weight. Use a thin title strip for session identity and a quiet bottom status bar for layout, persistence, and shortcuts.

### Workspace hierarchy

Keep the model explicit: workspace/project → window/tab → pane. Each pane has a stable ID, connection metadata, title, working directory, geometry, focus state, and activity state. Renderer layout state is separate from PTY/session state so resizing or rearranging a pane does not recreate its terminal process.

### Pane layouts and groups

Provide opinionated presets—stack, main-left, main-top, even-horizontal, even-vertical, and tiled—plus recursive horizontal/vertical splits. Pane focus, maximize/restore, equalize, rotate, swap, and directional resize must be keyboard-accessible. Broadcast/synchronized input is scoped to an explicit pane group, visibly active, and confirmed before destructive or multi-host commands.

### Overview and persistence

The overview represents the complete pane tree, not only a session list. Thumbnails identify workspace, tab, pane title, host, and activity state. Persist topology, pane dimensions, titles, connection targets, working directories, and focused pane independently from terminal scrollback. A restored view must distinguish a reconnected process from a newly created shell.

### Command palette

The command palette is the primary discovery surface for keyboard users. It should support session switching, pane creation, layout changes, reconnect, AI actions, and settings.

### AI approval surface

Any AI-generated command that changes system state should be shown before execution with:

- The target session and host
- The exact command
- A concise explanation
- Risk/privilege indicators
- Approve, edit, and cancel actions

### Voice state

Voice/listening state must be visible and paired with text. A microphone icon alone is insufficient. Listening, transcribing, executing, and muted states need distinct labels and accessible announcements.

## Do's and Don'ts

- Do keep terminal output visually dominant.
- Do preserve user focus and avoid surprise pane changes.
- Do show connection and persistence state explicitly.
- Do make destructive AI actions require approval.
- Do support keyboard-first operation.
- Don't use glowing effects continuously; reserve emphasis for focus and active events.
- Don't hide remote host identity.
- Don't silently execute generated commands.
- Don't make voice or eye tracking necessary for any core action.
- Don't use a dense dashboard layout that separates the user from the shell.
