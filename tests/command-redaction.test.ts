import { describe, expect, it } from 'vitest';
import { isStorable, looksHighEntropy, redactionReason } from '../src/renderer/command-redaction';

/**
 * Commands that must never reach the store, with the rule each one exercises.
 *
 * The values here are shaped like real credentials but are not any: they are
 * assembled to match the vendor prefixes without being valid keys.
 */
const MUST_REFUSE: Array<[string, string]> = [
  // Assignments, in every form a shell offers.
  ['export GITHUB_TOKEN=ghp_0123456789abcdefghij', 'export'],
  ['GITHUB_TOKEN=abc123 gh repo list', 'inline assignment prefix'],
  ['export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI', 'secret access key'],
  ['DB_PASSWORD=hunter2 ./migrate.sh', 'password'],
  ['env STRIPE_SECRET=sk_live_abc ./charge', 'env prefix'],
  ['declare -x MY_API_KEY=xyz', 'declare'],
  ['export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop', 'api key'],
  ['npm config set //registry.npmjs.org/:_authToken=abc123def', 'auth token assignment'],
  ['export GPG_PASSPHRASE=correct-horse', 'passphrase'],
  ['cmd && export TOKEN=abc', 'after a separator'],
  ['export PRIVATE_KEY=abcdef', 'private key'],

  // Flags carrying a value.
  ['curl --header "Authorization: Bearer abc" https://api.example.com', 'auth header'],
  ['curl -H "X-Api-Key: abc123" https://api.example.com', 'api key header'],
  ['docker login --password hunter2 -u me registry.example.com', 'long password flag'],
  ['gh auth login --with-token --token ghp_abc', 'token flag'],
  ['aws configure --secret abc', 'secret flag'],
  ['some-tool --api-key=abcdef123456', 'attached api key'],
  ['mysql -pSuperSecret mydb', 'attached mysql password'],
  ['mysqldump -phunter2 db > out.sql', 'attached mysqldump password'],
  ['curl -u admin:hunter2 https://api.example.com', 'basic auth'],
  ['openssl enc -d -aes256 -passin pass:hunter2 -in f', 'openssl passin'],

  // Credentials inside a URL.
  ['git clone https://stephen:ghp_abc123def456@github.com/o/r.git', 'url credentials'],
  ['psql postgres://user:hunter2@db.example.com/app', 'postgres url'],

  // Vendor-shaped tokens as bare arguments, which no structural rule can catch.
  ['echo ghp_0123456789abcdefghijklmn', 'github token'],
  ['echo github_pat_11ABCDEFG0abcdefghijklmn', 'fine-grained pat'],
  ['echo xoxb-123456789012-abcdefghijkl', 'slack bot token'],
  ['echo AKIAIOSFODNN7EXAMPLE', 'aws access key id'],
  ['echo glpat-abcdefghijklmnopqrst', 'gitlab pat'],
  ['curl -d eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', 'jwt'],

  // A long mixed-case token as a bare argument.
  ['deploy --to prod aB3dEfGh1jKlMn0pQrStUvWxYz', 'high entropy word']
];

/**
 * Commands that must survive, because a history that refuses these is not worth
 * keeping. Every one is something a developer types many times a day.
 */
const MUST_KEEP = [
  'git status',
  'git commit -m "fix the thing"',
  'git show 8f4a2b1c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a',
  'git log --oneline -20',
  'git push --set-upstream origin main',
  // A path to a password is not a password; refusing these would cost ordinary
  // commands for no gain.
  'restic --password-file /dev/stdin',
  'docker login --password-stdin registry.example.com',
  'npm run build',
  'npm test -- --watch',
  'docker run -p 8080:80 -u 1000:1000 nginx',
  'docker compose up -d',
  'kubectl get pods -n production',
  'ssh dev@build.example.com',
  'scp file.txt dev@host:/srv/app/',
  'curl https://api.example.com/v1/health',
  'curl -X POST https://api.example.com/things -d @body.json',
  'grep -rn "TODO" src/',
  'cd /srv/app && ls -la',
  'export PATH=/usr/local/bin:$PATH',
  'export EDITOR=vim',
  'unset GITHUB_TOKEN',
  'echo $GITHUB_TOKEN',
  'sudo systemctl restart nginx',
  'tail -f /var/log/syslog',
  'python3 -m http.server 8000',
  'psql -h db.example.com -U app -d app',
  'ls ~/Documents/development/ZeroGTerm/src/renderer',
  'find . -name "*.test.ts" -newer package.json'
];

describe('what must never be stored', () => {
  for (const [command, rule] of MUST_REFUSE) {
    it(`refuses ${rule}`, () => {
      expect(redactionReason(command)).not.toBeNull();
      expect(isStorable(command)).toBe(false);
    });
  }
});

describe('what must still be stored', () => {
  for (const command of MUST_KEEP) {
    it(`keeps ${command}`, () => {
      expect(redactionReason(command)).toBeNull();
    });
  }
});

describe('the shape of a refusal', () => {
  it('names the rule without carrying any of the command', () => {
    // The reason is logged and counted; the command is not.
    const reason = redactionReason('export GH_TOKEN=ghp_0123456789abcdefghij');
    expect(reason).toBe('secret-assignment');
    expect(JSON.stringify(reason)).not.toMatch(/ghp_/);
  });

  it('does not refuse an unsetting or a reference, which reveal nothing', () => {
    // `unset` and `$VAR` carry the name but never the value.
    expect(redactionReason('unset AWS_SECRET_ACCESS_KEY')).toBeNull();
    expect(redactionReason('echo "$DB_PASSWORD" | wc -c')).toBeNull();
  });

  it('treats an empty or blank command as nothing to refuse', () => {
    expect(redactionReason('')).toBeNull();
    expect(redactionReason('   ')).toBeNull();
  });

  it('refuses a bare -p only for the clients where it means a password', () => {
    // `docker run -p 8080:80` is a port mapping and by far the common case.
    expect(redactionReason('docker run -p 8080:80 nginx')).toBeNull();
    expect(redactionReason('mysql -phunter2')).not.toBeNull();
  });

  it('refuses a bare -u only for the HTTP clients', () => {
    // `-u` is a user id to docker, chown and su.
    expect(redactionReason('docker run -u 1000:1000 alpine')).toBeNull();
    expect(redactionReason('chown -R 1000:1000 /srv')).toBeNull();
    expect(redactionReason('curl -u me:secret https://x.example.com')).not.toBeNull();
  });
});

describe('looksHighEntropy', () => {
  it('accepts a generated-looking token', () => {
    expect(looksHighEntropy('aB3dEfGh1jKlMn0pQrStUvWxYz')).toBe(true);
    expect(looksHighEntropy('Zm9vYmFyYmF6MTIzNDU2Nzg5MA==')).toBe(true);
  });

  it('rejects a git SHA, which is long but harmless', () => {
    // Refusing every `git show <sha>` would gut the history.
    expect(looksHighEntropy('8f4a2b1c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a')).toBe(false);
    expect(looksHighEntropy('8F4A2B1C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A')).toBe(false);
  });

  it('rejects a path, which is long and mixed but not a secret', () => {
    expect(looksHighEntropy('/Users/Stephen/Documents/Dev1/src')).toBe(false);
    expect(looksHighEntropy('C:\\Users\\Stephen\\Projects1')).toBe(false);
  });

  it('rejects anything short', () => {
    expect(looksHighEntropy('aB3dEfGh1jK')).toBe(false);
  });

  it('rejects a long word that is all one case', () => {
    // Prose and long flag names are not credentials.
    expect(looksHighEntropy('averyveryverylongflagname')).toBe(false);
    expect(looksHighEntropy('ALLCAPSCONSTANTNAMEHERE12')).toBe(false);
  });

  it('rejects a word carrying punctuation a token would not', () => {
    expect(looksHighEntropy('some.file.Name1.With.Dots')).toBe(false);
  });
});
