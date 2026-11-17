import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const environment = { ...process.env };
delete environment.npm_config_allow_scripts;
delete environment.NPM_CONFIG_ALLOW_SCRIPTS;

const result = spawnSync(npmCommand, ['audit', '--audit-level=high'], {
  env: environment,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
