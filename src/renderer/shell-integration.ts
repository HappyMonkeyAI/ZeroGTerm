// The shell integration snippets, one per shell.
//
// Deliberately a snippet to paste, not `zerogterm init bash` for `eval` — the
// idiom McFly, starship and zoxide all use. That idiom cannot work for the case
// that matters here: a remote host does not have `zerogterm` on its PATH and
// never will, so `eval "$(zerogterm init bash)"` in a server's ~/.bashrc is a
// line that fails on every login. A few lines of portable shell work everywhere,
// locally and over SSH, and depend on nothing being installed.
//
// What they emit is standard OSC 133 and nothing invented here: A before the
// prompt, B where the user's input starts, C when the command is handed over,
// and D with the exit status. Anyone who already has these from VS Code, kitty
// or an oh-my-zsh plugin needs none of this — ZeroG reads what is already there.

export type IntegrationShell = 'bash' | 'zsh' | 'fish' | 'powershell';

export const INTEGRATION_SHELLS: Array<{ id: IntegrationShell; label: string; file: string }> = [
  { id: 'bash', label: 'bash', file: '~/.bashrc' },
  { id: 'zsh', label: 'zsh', file: '~/.zshrc' },
  { id: 'fish', label: 'fish', file: '~/.config/fish/config.fish' },
  { id: 'powershell', label: 'PowerShell', file: '$PROFILE' }
];

/**
 * bash has no preexec hook, so the DEBUG trap stands in for one.
 *
 * The guard matters: the trap fires for every command in a pipeline and for the
 * PROMPT_COMMAND itself, so without it every prompt would report a command. The
 * flag is set when the prompt is drawn and cleared on the first trap after it,
 * which is the one that is the user's command.
 */
const BASH = `# ZeroG shell integration — reports prompt and command marks (OSC 133).
__zerog_at_prompt=1
__zerog_preexec() {
  [ -n "\${COMP_LINE-}" ] && return
  [ -z "\${__zerog_at_prompt-}" ] && return
  __zerog_at_prompt=
  printf '\\033]133;C\\007'
}
__zerog_precmd() {
  local status=$?
  printf '\\033]133;D;%s\\007' "$status"
  printf '\\033]7;file://%s%s\\007' "$HOSTNAME" "$PWD"
  __zerog_at_prompt=1
  printf '\\033]133;A\\007'
}
trap '__zerog_preexec' DEBUG
PROMPT_COMMAND="__zerog_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1="\\[\\033]133;A\\007\\]$PS1\\[\\033]133;B\\007\\]"`;

const ZSH = `# ZeroG shell integration — reports prompt and command marks (OSC 133).
autoload -Uz add-zsh-hook
__zerog_preexec() { printf '\\033]133;C\\007' }
__zerog_precmd() {
  printf '\\033]133;D;%s\\007' "$?"
  printf '\\033]7;file://%s%s\\007' "$HOST" "$PWD"
}
add-zsh-hook preexec __zerog_preexec
add-zsh-hook precmd __zerog_precmd
PS1=$'%{\\033]133;A\\007%}'$PS1$'%{\\033]133;B\\007%}'`;

/**
 * fish emits its prompt from `fish_prompt`, so B has to come after that runs.
 *
 * The prompt event fires before the prompt is printed, which is fine for A but
 * useless for B — B marks where the user's input begins, and that is after the
 * prompt text. So the user's own `fish_prompt` is copied aside and wrapped.
 * Because of that, this snippet belongs at the *end* of config.fish, after
 * whatever defines the prompt.
 */
const FISH = `# ZeroG shell integration — reports prompt and command marks (OSC 133).
# Add this at the end of config.fish, after your prompt is defined.
if not functions -q __zerog_inner_prompt
    functions --copy fish_prompt __zerog_inner_prompt
end
function fish_prompt
    printf '\\033]133;A\\007'
    printf '\\033]7;file://%s%s\\007' (hostname) "$PWD"
    __zerog_inner_prompt
    printf '\\033]133;B\\007'
end
function __zerog_preexec --on-event fish_preexec
    printf '\\033]133;C\\007'
end
function __zerog_postexec --on-event fish_postexec
    printf '\\033]133;D;%s\\007' $status
end`;

/**
 * PowerShell has no preexec hook, so C comes from PSReadLine's Enter handler.
 *
 * That is the only place the command can be marked at the right moment: the
 * prompt function runs *after* the command has finished, by which point the
 * cursor has moved past the output and reading the grid would capture that
 * instead of the command. Binding Enter puts C exactly where B's counterpart
 * belongs — input complete, cursor still at its end.
 *
 * Guarded, because PSReadLine is not guaranteed to be loaded. Without it the
 * prompt marks and the exit status still work; only the command text is missing,
 * and a pane that records nothing is the documented degraded case.
 */
const POWERSHELL = `# ZeroG shell integration — reports prompt and command marks (OSC 133).
$global:__zerogPrompt = $function:prompt
function prompt {
    $status = if ($?) { 0 } else { 1 }
    [Console]::Write("\`e]133;D;$status\`a")
    [Console]::Write("\`e]7;file://$env:COMPUTERNAME$($PWD.Path)\`a")
    [Console]::Write("\`e]133;A\`a")
    $text = & $global:__zerogPrompt
    [Console]::Write("\`e]133;B\`a")
    return $text
}
try {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
        [Console]::Write("\`e]133;C\`a")
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
} catch {
    # PSReadLine is absent, so the command text cannot be marked. The prompt
    # marks and the exit status still report.
}`;

const SNIPPETS: Record<IntegrationShell, string> = {
  bash: BASH,
  zsh: ZSH,
  fish: FISH,
  powershell: POWERSHELL
};

export function integrationSnippet(shell: IntegrationShell): string {
  return SNIPPETS[shell];
}

/** Where the snippet goes, for the sentence beside the Copy button. */
export function integrationFile(shell: IntegrationShell): string {
  return INTEGRATION_SHELLS.find((entry) => entry.id === shell)?.file ?? '';
}
