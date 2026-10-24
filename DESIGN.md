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
  # The renderer's real tokens (src/renderer/styles.css :root), named as in CSS.
  # The roles above map onto them: primary = surface-0, neutral = text-1,
  # muted = text-3, border = line-1, tertiary = blue, success = green,
  # warning = yellow, danger = red. secondary has no CSS counterpart (see "Measured drift").
  surface-0: "#0A0C10"
  surface-1: "#0D1015"
  surface-2: "#11161E"
  surface-3: "#151A22"
  surface-4: "#1A202A"
  line-1: "#202630"
  line-2: "#2A3340"
  line-3: "#303B4B"
  text-1: "#D8DEE9"
  text-2: "#8B93A3"
  text-3: "#697386"
  text-4: "#4E5969"
  icon: "#AAB3C5"
  blue: "#7AA2F7"
  green: "#9ECE6A"
  yellow: "#E0AF68"
  red: "#F7768E"
  cyan: "#7DCFFF"
  teal: "#73DACA"
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

Values match the token frontmatter above and the renderer's CSS variables. An earlier version of
this list gave a different palette (#0B0F14, a cyan #6EE7F9 accent, …) that matched neither.

- **Primary (#0A0C10, `--surface-0`):** Near-black blue background for terminal panes and the application canvas.
- **Surfaces (`--surface-1`…`--surface-4`, #0D1015 → #1A202A):** Elevation steps for chrome: drawer and bars, tabs, raised controls.
- **Tertiary (#7AA2F7, `--blue`):** Blue interaction accent used sparingly for focus, links, and primary actions. `--cyan` (#7DCFFF) and `--teal` (#73DACA) are secondary accents.
- **Neutral (#D8DEE9, `--text-1`):** High-contrast foreground text and important terminal metadata.
- **Text tiers (`--text-2` #8B93A3, `--text-3` #697386, `--text-4` #4E5969):** Secondary labels down to the faintest hints. See "Measured drift" before using `--text-3` or `--text-4` for text people must read.
- **Muted (#697386, `--text-3`):** Secondary labels and inactive session information.
- **Lines (`--line-1`…`--line-3`, #202630 → #303B4B):** Pane dividers and structural boundaries. Border = `--line-1`.
- **Success (#9ECE6A, `--green`):** Connected, completed, or healthy state.
- **Warning (#E0AF68, `--yellow`):** Pending approval, degraded connection, or attention required.
- **Danger (#F7768E, `--red`):** Failure and destructive-action state.

Do not use color as the only state indicator. Pair status colors with text, icons, or shape changes.

### Light theme (as shipped)

`:root[data-theme='light']` overrides element backgrounds rather than the `--surface-*` variables, so its palette
lives in `src/renderer/styles.css` and was not described here before:

- **Canvas (#F7F9FC):** page, app shell, workspace, panes, terminal.
- **Panels (#FFFFFF):** window bar, session drawer, status bar.
- **Recessed (#EEF2F7):** rail, workspace head, empty pane.
- **Lines (#DBE2EC):** borders and the pane grid.
- **Text:** #253044 primary, #5C687B and #68768A secondary. #5C687B passes WCAG AA on every light surface (5.0:1 or better). #68768A passes only on the white panels (4.62:1); it fails on the canvas (4.38:1) and on recessed areas (4.11:1), so see "Measured drift" (row 10) before using it for text people must read.

## Typography

Use a proportional sans-serif for application chrome and a monospaced face for terminal content, paths, commands, session names, and technical identifiers. Favor readable line height and stable alignment over decorative typography.

## Layout

- The terminal canvas is the dominant surface; chrome must recede behind it.
- Use a narrow icon rail, a compact session drawer, and a thin window/command bar rather than a dashboard header.
- The workspace is a pane tree with stack, vertical split, horizontal split, and grid layouts.
- Pane dividers are one-pixel structural lines; focus is shown by a restrained accent edge, never a glowing card.
- Session overview is a transient thumbnail grid opened from the top bar, rail, or `Ctrl+Shift+O`.
- Keyboard navigation must have a mouse-equivalent path: `Ctrl+Shift+T` opens a new local terminal, `Ctrl+Shift+N` a new workspace, `Ctrl+Shift+L` toggles a split, and `Ctrl+Shift+O` opens overview (defaults from `src/renderer/shortcuts.ts`; all rebindable).
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

A shared port sits outside that hierarchy, attached to a host rather than to a workspace or a pane. A bound port is a fact about the machine, not about the view: scoping one to a workspace would let two workspaces each believe they owned `localhost:3000`. Forwards are therefore listed in their own sidebar view, grouped by host, and survive switching or closing the workspace whose terminals prompted them.

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

## Measured drift (2026-10-24)

Measured from the running renderer with Spine Design:
- Vite dev server, 1280×800, dark and light themes, plus the command palette (Ctrl+Shift+R).
- The packaged Electron app, with one live local session (Ctrl+Shift+T, then submit the dialog), in a throwaway profile. Terminal contents were masked, so `terminal-pane` itself isn't measured.

Each item is a decision: either this spec or the app should change. A suggested direction is given; nothing here has been applied to the app.

| # | Spec says | App measures | Suggested direction |
|---|-----------|--------------|---------------------|
| 1 | **Muted** text (#697386) on Primary | 4.1:1 on `--surface-0`, 3.99:1 on `--surface-1`, 3.66:1 on `--surface-3`. **Below WCAG AA (4.5:1) on every dark surface.** 46 text elements use it. | Use `--text-2` (#8B93A3: 6.17:1 on `--surface-1`, 5.65:1 on `--surface-3`) for secondary text people must read. Keep `--text-3` for non-essential hints. |
| 2 | — | `--text-4` (#4E5969) is used for 9px control labels and pane hints: 2.68:1. `--line-3` (#303B4B) is used for `/` separators: 1.68:1 (1.54:1 in light). | Don't use `--text-4` or `--line-*` for text. Raise to `--text-2`, or mark them decorative (`aria-hidden`). |
| 3 | `body-md` 14px (0.875rem) | Chrome text is **13px** on 117 elements | Probably update the spec to 13px (0.8125rem). The chrome is consistent at 13px, so this looks deliberate. |
| 4 | `label` 11px | Also 10px (17 elements) and 9px (5), and the 9px ones fail contrast | Raise 9–10px text to `label` 11px. |
| 5 | Radii 4 / 6 / 10px | Rail buttons use **5px** (11 elements) | Change the rail buttons to `rounded.sm` 4px. |
| 6 | `session-sidebar`: radius 6px, padding 12px | The drawer is a full-height edge panel: radius 0, padding 0 (its rows carry the padding) | Update the spec to describe the edge panel (radius 0; padding on rows). |
| 7 | `command-palette`: radius 10px (`lg`), padding 16px (`lg`) | Radius **7px**, padding **10px** | Decide which is intended. 7px is off the radius scale either way. |
| 8 | `secondary` #0F1218 | Not a CSS token: drawer and bars use `--surface-1` / `--surface-2` | Point `secondary` at `--surface-2` (#11161E), or retire it. |
| 9 | Accent = `--blue` #7AA2F7 | One border uses **#3B82F6**, which isn't a token (it looks like Tailwind blue-500) | Replace with `--blue`. |
| 10 | Single dark palette | A light theme ships (above) with its own text tiers: #68768A is 4.62:1 on #FFFFFF but 4.38:1 on #F7F9FC, 4.11:1 on #EEF2F7 and 3.54:1 on #DBE2EC | Add light-theme tokens to the frontmatter once the format supports themes. Until then, keep the list above current. |
| 11 | `session-item-active`: `rounded.sm` 4px, `spacing.sm` 8px padding, `{colors.border}` background | The active `.session-row` has radius **5px**, padding **9px 8px**, background `--surface-4` #1A202A (close to `border`) | Same 5px as the rail buttons: move both to 4px, and the padding to 8px, together. |
