const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { sshArguments, readSSHSettings } = require('./ssh-config.cjs');

class RemoteConnection {
  constructor(project, { integrationDir, auth, sessionKey, onEvent, onReady, sshPath, askpassPath, codingPath, extraEnv = {} }) {
    const worker = fs.readFileSync(path.join(integrationDir, 'remote-worker.py'));
    this.project = project; this.auth = auth; this.events = new EventEmitter();
    this.pending = new Map(); this.nextId = 0; this.buffer = ''; this.connected = false; this.closed = false;
    this.decoder = new StringDecoder('utf8'); this.terminalDecoder = new StringDecoder('utf8'); this.errorDecoder = new StringDecoder('utf8');
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.onEvent = onEvent; this.onReady = onReady;
    const authEnv = auth.register(project.id, project.ssh.host, () => this.fail(new Error('已取消 SSH 连接。')));
    const env = { ...process.env, ...extraEnv, ...authEnv, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'project-grid:0' };
    const askpass = askpassPath || path.join(integrationDir, process.platform === 'win32' ? 'ssh-askpass.exe' : 'ssh-askpass.sh');
    env.SSH_ASKPASS = process.platform === 'win32' ? '"' + askpass.replace(/\\/g, '/') + '"' : askpass;
    env.PROJECT_GRID_ASKPASS_NODE = process.execPath;
    env.PROJECT_GRID_ASKPASS_SCRIPT = path.join(integrationDir, 'ssh-askpass.cjs');
    // Never inherit a different application's askpass implementation.
    delete env.ELECTRON_RUN_AS_NODE;
    const executable = sshPath || readSSHSettings().sshPath;
    this.child = spawn(executable, sshArguments(project.ssh), { env, cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => this.fail(new Error(`无法启动 SSH：${error.message}`)));
    this.child.stdout.on('data', data => this.receive(this.decoder.write(data)));
    this.child.stderr.on('data', data => {
      const text = this.errorDecoder.write(data);
      this.lastError = (this.lastError || '') + text;
      this.lastError = this.lastError.slice(-4000);
      this.events.emit('data', text.replace(/\r?\n/g, '\r\n'));
    });
    this.child.stdin.on('error', () => {});
    this.child.on('close', code => {
      if (!this.closed) this.fail(new Error(this.lastError?.trim() || `SSH 已断开（${code ?? '连接关闭'}），可重新连接。`));
    });
    let seconds = 0;
    this.connectTimer = setInterval(() => {
      if (!auth.hasPending(project.id)) seconds++;
      if (seconds > 60) this.fail(new Error('SSH 连接超时。请确认主机可连接，且远端已安装 Python 3 和 Bash。'));
    }, 1000);
    this.connectTimer.unref?.();
    this.child.stdin.write(worker.toString('base64') + '\n');
    this.send({ path: project.path, codingPath, projectId: project.id, token: sessionKey, cols: 90, rows: 24 });
  }
  onData(callback) { this.events.on('data', callback); return { dispose: () => this.events.off('data', callback) }; }
  onExit(callback) { this.events.on('exit', callback); return { dispose: () => this.events.off('exit', callback) }; }
  emitExit(code) { if (!this.exited) { this.exited = true; this.events.emit('exit', { exitCode: code }); } }
  receive(text) {
    if (this.closed) return;
    this.buffer += text;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 2 * 1024 * 1024) { this.fail(new Error('远程连接返回的数据过大。')); return; }
      if (!line.startsWith('PGW1 ')) { if (line) this.events.emit('data', line + '\r\n'); continue; }
      let message;
      try { message = JSON.parse(line.slice(5)); } catch { this.fail(new Error('远程连接返回了无效的数据。')); return; }
      if (message.type === 'ready') {
        if (typeof message.info?.root !== 'string' || !message.info.root.startsWith('/')) { this.fail(new Error('远程目录无效。')); return; }
        clearInterval(this.connectTimer);
        this.connected = true; this.info = message.info;
        this.resolveReady(message.info); this.onReady?.(message.info);
        if (this.dimensions) this.send({ op: 'resize', ...this.dimensions });
      } else if (message.type === 'data' && typeof message.data === 'string') {
        this.events.emit('data', this.terminalDecoder.write(Buffer.from(message.data, 'base64')));
      } else if (message.type === 'event' && message.event && typeof message.event === 'object') this.onEvent?.(message.event);
      else if (message.type === 'exit') this.emitExit(Number.isInteger(message.code) ? message.code : 1);
      else if (message.type === 'error') this.fail(new Error(String(message.error || '远程连接失败。')));
      else if (message.type === 'response') {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message.value);
        else request.reject(new Error(String(message.error || '远程请求失败。')));
      }
    }
    if (this.buffer.length > 2 * 1024 * 1024) this.fail(new Error('远程连接返回的数据过大。'));
  }
  send(message) {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  async request(op, data = {}) {
    await this.ready;
    if (this.closed) throw new Error('SSH 连接已断开，请重新连接。');
    if (this.pending.size >= 64) throw new Error('远程请求较多，请稍后重试。');
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('读取远程文件超时，请重试。')); }, 30000);
      timer.unref?.(); this.pending.set(id, { resolve, reject, timer });
      this.send({ ...data, op, id });
    });
  }
  write(data) {
    if (this.connected && !this.exited) this.send({ op: 'input', data: Buffer.from(data).toString('base64') });
  }
  resize(cols, rows) {
    this.dimensions = { cols, rows };
    if (this.connected && !this.exited) this.send({ op: 'resize', cols, rows });
  }
  fail(error) {
    if (this.closed) return;
    this.error = error.message;
    this.events.emit('data', `\r\n[SSH] ${error.message}\r\n`);
    this.close(error); this.emitExit(255);
  }
  close(error = new Error('SSH 连接已关闭。')) {
    if (this.closed) return;
    this.send({ op: 'shutdown' });
    this.closed = true; this.connected = false;
    clearInterval(this.connectTimer); this.rejectReady(error);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.auth.unregister(this.project.id);
    this.child.stdin.end();
    const child = this.child;
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000);
    timer.unref?.(); child.once('close', () => clearTimeout(timer));
  }
  kill() { this.close(); }
}

module.exports = { RemoteConnection };
