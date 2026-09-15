const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeSSH, listSSHHosts, readSSHSettings, sshArguments } = require('../electron/ssh-config.cjs');

test('SSH inputs are data, not commands, and preserve Linux case and paths', () => {
  assert.deepEqual(normalizeSSH({ host: 'dev@linux', path: '/home/dev/My Project' }), { host: 'dev@linux', path: '/home/dev/My Project', configFile: null });
  for (const host of ['-oProxyCommand=anything', 'ssh host', 'host;command', 'host\nOther', '$(command)', '`command`']) assert.throws(() => normalizeSSH({ host, path: '~/project' }));
  for (const value of ['C:\\project', 'relative/path', '/bad\0path']) assert.throws(() => normalizeSSH({ host: 'linux', path: value }));
  const args = sshArguments({ host: 'linux-dev', configFile: null });
  assert.ok(args.includes('-T'));
  assert.equal(args.at(-2), 'linux-dev');
  assert.ok(!args.some(arg => arg.includes('StrictHostKeyChecking=no')));
});

test('host discovery follows includes, skips wildcards and never executes Match commands', async t => {
  const prefix = path.join(os.tmpdir(), 'project-grid-ssh-config-');
  const home = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(path.resolve(home).startsWith(prefix)); await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(path.join(home, '.ssh', 'config.d'), { recursive: true });
  const config = path.join(home, '.ssh', 'config');
  await fs.writeFile(config, 'Host dev alias\n  HostName example.invalid\nHost * !excluded\nInclude config.d/*.conf\nMatch exec "DO_NOT_RUN"\n');
  await fs.writeFile(path.join(home, '.ssh', 'config.d', 'other.conf'), 'Host "server-two"\nInclude config\n');
  assert.deepEqual(listSSHHosts(config, home), ['alias', 'dev', 'server-two']);
  const settings = path.join(home, 'settings.json');
  await fs.writeFile(settings, '{ // VS Code allows comments\n "remote.SSH.configFile": "~/.ssh/config",\n}');
  assert.equal(readSSHSettings({ home, settingsFile: settings }).configFile, config);
});
