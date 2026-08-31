import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_SHELLS,
  integrationFile,
  integrationSnippet,
  type IntegrationShell
} from '../src/renderer/shell-integration';

const SHELLS: IntegrationShell[] = ['bash', 'zsh', 'fish', 'powershell'];
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('every snippet', () => {
  for (const shell of SHELLS) {
    describe(shell, () => {
      const snippet = integrationSnippet(shell);

      it('emits all four marks', () => {
        // Without D there is no exit status, and without B there is nowhere to
        // read the command text from — each mark carries something the history
        // uses.
        for (const mark of ['133;A', '133;B', '133;C', '133;D']) {
          expect(snippet).toContain(mark);
        }
      });

      it('writes the escape as characters for the shell to interpret', () => {
        // The load-bearing assertion. These snippets are pasted into an rc file,
        // so they must carry the four characters \\033 (or PowerShell's `e) for
        // the shell to turn into an escape at runtime. A real ESC byte in the
        // source would look identical here and be pasted as an invisible
        // control character, which is exactly the failure this pins down.
        expect(snippet).not.toContain(ESC);
        expect(snippet).not.toContain(BEL);
        if (shell === 'powershell') expect(snippet).toContain('`e]133;A');
        else expect(snippet).toContain('\\033]133;A');
      });

      it('carries no control characters at all, so it survives a copy', () => {
        const controls = [...snippet].filter((character) => {
          const code = character.charCodeAt(0);
          return code < 32 && character !== '\n' && character !== '\t';
        });
        expect(controls).toEqual([]);
      });

      it('reports the working directory too, which cwd tracking already reads', () => {
        // OSC 7 costs one line here and makes the existing cwd tracker exact
        // instead of parsing it out of the prompt.
        expect(snippet).toContain(']7;file://');
      });

      it('says what it is, since it is pasted into a file someone will reread', () => {
        expect(snippet.split('\n')[0]).toMatch(/^#|^\$global/);
        expect(snippet).toContain('ZeroG');
      });
    });
  }
});

describe('bash, which has no preexec hook', () => {
  const snippet = integrationSnippet('bash');

  it('uses the DEBUG trap and guards it', () => {
    // The trap fires for every command in a pipeline and for PROMPT_COMMAND
    // itself; without the guard every prompt would report a command.
    expect(snippet).toContain('trap');
    expect(snippet).toContain('DEBUG');
    expect(snippet).toContain('__zerog_at_prompt');
  });

  it('keeps any PROMPT_COMMAND already set', () => {
    // Replacing it outright would silently break whatever the user had.
    expect(snippet).toContain('${PROMPT_COMMAND:+');
  });

  it('wraps the existing prompt rather than replacing it', () => {
    expect(snippet).toContain('$PS1');
  });
});

describe('zsh', () => {
  it('adds hooks rather than assigning them, so nothing else is displaced', () => {
    const snippet = integrationSnippet('zsh');
    expect(snippet).toContain('add-zsh-hook preexec');
    expect(snippet).toContain('add-zsh-hook precmd');
  });

  it('marks the prompt inside %{ %} so the marks take no width', () => {
    // Zero-width escapes are what stop zsh miscounting the prompt length and
    // wrapping the line in the wrong place.
    expect(integrationSnippet('zsh')).toContain('%{');
  });
});

describe('fish', () => {
  it('uses the events fish provides for the command itself', () => {
    const snippet = integrationSnippet('fish');
    expect(snippet).toContain('--on-event fish_preexec');
    expect(snippet).toContain('--on-event fish_postexec');
  });

  it('wraps the prompt rather than using the prompt event', () => {
    // The fish_prompt event fires *before* the prompt is printed, which is fine
    // for A and useless for B — B marks where the user's input begins, and that
    // is after the prompt text. Wrapping is the only way to get B in the right
    // place.
    const snippet = integrationSnippet('fish');
    expect(snippet).toContain('functions --copy fish_prompt __zerog_inner_prompt');
    expect(snippet).toContain('__zerog_inner_prompt');
    expect(snippet.indexOf('133;B')).toBeGreaterThan(snippet.indexOf('__zerog_inner_prompt'));
  });

  it('does not copy the prompt twice if the snippet is sourced again', () => {
    expect(integrationSnippet('fish')).toContain('if not functions -q __zerog_inner_prompt');
  });

  it('says it belongs after the prompt is defined', () => {
    // Order matters in config.fish: wrapping a prompt that does not exist yet
    // would capture the default instead of the user's.
    expect(integrationSnippet('fish')).toMatch(/end of config\.fish/);
  });
});

describe('PowerShell, which has no preexec hook either', () => {
  it('keeps the existing prompt function and calls it', () => {
    const snippet = integrationSnippet('powershell');
    expect(snippet).toContain('$function:prompt');
    expect(snippet).toContain('& $global:__zerogPrompt');
  });
});

describe('where each snippet goes', () => {
  it('names a file for every shell offered', () => {
    for (const { id } of INTEGRATION_SHELLS) {
      expect(integrationFile(id)).not.toBe('');
    }
  });

  it('offers exactly the shells that have a snippet', () => {
    expect(INTEGRATION_SHELLS.map((entry) => entry.id).sort()).toEqual([...SHELLS].sort());
  });
});
