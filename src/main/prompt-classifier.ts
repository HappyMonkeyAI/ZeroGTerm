export type McpPromptKind = 'password' | 'passphrase' | 'verification-code' | 'host-key' | 'unknown';

export interface McpPromptClassification {
  kind: McpPromptKind;
  text: string;
  answerableByMcp: false;
}

const PASSWORD = /password|passwd|login\s*:/i;
const PASSPHRASE = /passphrase|private\s+key/i;
const CODE = /verification|one[- ]time|security\s+code|otp|authenticator/i;
const HOST_KEY = /are you sure you want to continue connecting|authenticity of host|fingerprint|host key/i;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Classify untrusted terminal text without ever accepting an answer. */
export function classifyMcpPrompt(raw: string): McpPromptClassification {
  const text = raw.replace(ANSI, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 512);
  const kind: McpPromptKind = PASSPHRASE.test(text) ? 'passphrase'
    : CODE.test(text) ? 'verification-code'
      : HOST_KEY.test(text) ? 'host-key'
        : PASSWORD.test(text) ? 'password' : 'unknown';
  return { kind, text, answerableByMcp: false };
}
