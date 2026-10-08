// The colour themes. The interface colours live in styles.css, as custom
// properties under :root[data-theme='<id>']; this file holds what the CSS
// cannot: the list, the labels, and the palette handed to xterm, which paints
// its own canvas and so never sees a stylesheet.
//
// The ids 'dark' and 'light' predate the list and are stored in people's
// settings, so they keep their names. 'dark' is Tokyo Night.

export type TerminalPalette = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black?: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta?: string;
  cyan: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
};

export type ThemeDefinition = {
  id: string;
  label: string;
  kind: 'dark' | 'light';
  terminal: TerminalPalette;
};

export const THEME_DEFINITIONS = [
  {
    id: 'dark',
    label: 'Tokyo Night',
    kind: 'dark',
    terminal: {
      background: '#0a0c10',
      foreground: '#d8dee9',
      cursor: '#9ece6a',
      selectionBackground: '#334155',
      green: '#9ece6a',
      yellow: '#e0af68',
      red: '#f7768e',
      blue: '#7aa2f7',
      cyan: '#7dcfff'
    }
  },
  {
    id: 'light',
    label: 'Light',
    kind: 'light',
    terminal: {
      background: '#f7f9fc',
      foreground: '#253044',
      cursor: '#16803c',
      selectionBackground: '#cbdcf5',
      green: '#16803c',
      yellow: '#a15c00',
      red: '#c53030',
      blue: '#2459a6',
      cyan: '#087f8c'
    }
  },
  {
    id: 'dracula',
    label: 'Dracula',
    kind: 'dark',
    terminal: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'nord',
    label: 'Nord',
    kind: 'dark',
    terminal: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#d57780',
      brightGreen: '#b4d19c',
      brightYellow: '#f0d399',
      brightBlue: '#8fb0d2',
      brightMagenta: '#c39cbd',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    kind: 'dark',
    terminal: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#657b83',
      brightYellow: '#839496',
      brightBlue: '#93a1a1',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'monokai',
    label: 'Monokai',
    kind: 'dark',
    terminal: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#e6db74',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#ff5c93',
      brightGreen: '#bdee5f',
      brightYellow: '#f0e68c',
      brightBlue: '#8be4f5',
      brightMagenta: '#c4a2ff',
      brightCyan: '#b9f5ec',
      brightWhite: '#f9f8f5'
    }
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    kind: 'dark',
    terminal: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      black: '#3f4451',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#ea8189',
      brightGreen: '#a9d08f',
      brightYellow: '#ecce94',
      brightBlue: '#7bbdf3',
      brightMagenta: '#d28ee6',
      brightCyan: '#6fc5d0',
      brightWhite: '#d7dae0'
    }
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    kind: 'dark',
    terminal: {
      background: '#262335',
      foreground: '#f4eefc',
      cursor: '#ff7edb',
      selectionBackground: '#463a6b',
      black: '#34294f',
      red: '#fe4450',
      green: '#72f1b8',
      yellow: '#fede5d',
      blue: '#6d9bff',
      magenta: '#ff7edb',
      cyan: '#36f9f6',
      white: '#f4eefc',
      brightBlack: '#6f6194',
      brightRed: '#ff6b73',
      brightGreen: '#97f7cc',
      brightYellow: '#fee98b',
      brightBlue: '#94b4ff',
      brightMagenta: '#ff9fe5',
      brightCyan: '#7bfbf9',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    kind: 'dark',
    terminal: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffffff',
      selectionBackground: '#3a3a3a',
      black: '#000000',
      red: '#ff6b6b',
      green: '#3fff6a',
      yellow: '#ffe14d',
      blue: '#6fc3ff',
      magenta: '#ff7be5',
      cyan: '#4de8ff',
      white: '#e6e6e6',
      brightBlack: '#8a8a8a',
      brightRed: '#ff9090',
      brightGreen: '#7dff98',
      brightYellow: '#fff08a',
      brightBlue: '#9fd8ff',
      brightMagenta: '#ffa3ee',
      brightCyan: '#8af0ff',
      brightWhite: '#ffffff'
    }
  }
] as const satisfies readonly ThemeDefinition[];

export type Theme = (typeof THEME_DEFINITIONS)[number]['id'];

export const THEMES: readonly Theme[] = THEME_DEFINITIONS.map((theme) => theme.id);

export const DEFAULT_THEME: Theme = 'dark';

export function themeDefinition(theme: Theme): ThemeDefinition {
  return THEME_DEFINITIONS.find((entry) => entry.id === theme) ?? THEME_DEFINITIONS[0];
}

export function isLightTheme(theme: Theme): boolean {
  return themeDefinition(theme).kind === 'light';
}

export function terminalPalette(theme: Theme): TerminalPalette {
  return themeDefinition(theme).terminal;
}

/**
 * Where the title bar's sun/moon button goes from here: to the light theme from
 * any dark one, and back to the dark theme last used from the light one.
 */
export function toggledTheme(current: Theme, lastDark: Theme): Theme {
  if (!isLightTheme(current)) return 'light';
  return isLightTheme(lastDark) ? DEFAULT_THEME : lastDark;
}
