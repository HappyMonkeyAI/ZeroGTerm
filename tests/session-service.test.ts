import { describe, expect, it } from 'vitest';
import { parseScreenList, validateSessionName, validateSshTarget } from '../src/main/session-service';

describe('screen session contract', () => {
  it('validates safe names', () => {
    expect(validateSessionName('project-1')).toBe('project-1');
    expect(() => validateSessionName('bad name')).toThrow();
    expect(() => validateSessionName('a;rm -rf /')).toThrow();
  });

  it('parses screen -ls output without shell interpolation', () => {
    const sessions = parseScreenList('There are screens on:\n\t1234.project-1\t(Detached)\n\t4567.other\t(Attached)\n2 Sockets in /run/screen/S-user.');
    expect(sessions.map(({ id, name }) => ({ id, name }))).toEqual([{ id: 'local:project-1', name: 'project-1' }, { id: 'local:other', name: 'other' }]);
  });

  it('builds SSH arguments without shell interpolation', () => {
    expect(validateSshTarget('dev@example.com:2222')).toEqual({ target: 'dev@example.com:2222', args: ['-tt', '-p', '2222', 'dev@example.com'] });
    expect(() => validateSshTarget('dev@example.com; touch /tmp/pwned')).toThrow();
  });
});
