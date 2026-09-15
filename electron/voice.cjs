const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const extract = require('extract-zip');

const RUNTIME = { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip', size: 3968674, sha256: 'd824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d' };
const MODEL = { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin?download=true', size: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' };
async function digest(filename) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

async function downloadAsset(asset, filename, fetcher, signal, progress) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  try { if ((await fsp.stat(filename)).size === asset.size && await digest(filename) === asset.sha256) { progress(asset.size); return; } } catch { }
  const partial = filename + '.partial';
  let offset = 0;
  try { offset = (await fsp.stat(partial)).size; } catch { }
  if (offset > asset.size) { await fsp.unlink(partial); offset = 0; }
  if (offset < asset.size) {
    const response = await fetcher(asset.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal });
    if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}），请检查网络后重试。`);
    if (response.status === 206) { if (!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('下载续传响应无效，请重试。'); }
    else offset = 0;
    const file = await fsp.open(partial, offset ? 'a' : 'w');
    try {
      for await (const value of response.body) {
        if (signal.aborted) throw new Error('下载已暂停。');
        if (offset + value.length > asset.size) throw new Error('下载文件大小不正确。');
        await file.writeFile(value); offset += value.length; progress(offset);
      }
    } finally { await file.close(); }
  }
  if (offset !== asset.size) throw new Error('下载中断，点击重试可继续下载。');
  if (await digest(partial) !== asset.sha256) { await fsp.unlink(partial); throw new Error('下载文件校验失败，请重试。'); }
  await fsp.rename(partial, filename);
}

function validateAudio(value) {
  const bytes = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  if (bytes.length < 44 || bytes.length > 20 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 32000 || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new Error('录音数据无效，请重新录制。');
  if (bytes.length - 44 < 16000) throw new Error('录音太短，请说完后再停止。');
  return bytes;
}

class VoiceManager {
  constructor({ directory, fetcher = fetch, changed = () => {} }) {
    Object.assign(this, { directory, fetcher, changed });
    this.state = { phase: 'missing', ready: false, percent: 0, error: null, model: 'Whisper Base · 本地多语言', downloadBytes: RUNTIME.size + MODEL.size };
    this.executable = path.join(directory, 'runtime', 'Release', 'whisper-cli.exe');
    this.model = path.join(directory, 'model.bin');
  }
  update(patch) { if (Object.keys(patch).every(key => this.state[key] === patch[key])) return; this.state = { ...this.state, ...patch }; this.changed({ ...this.state }); }
  async getState() {
    if (!this.initialized) {
      this.initialized = (async () => {
        try {
          if ((await fsp.stat(this.model)).size === MODEL.size && fs.existsSync(this.executable) && await digest(this.model) === MODEL.sha256) this.update({ phase: 'ready', ready: true, percent: 100 });
        } catch { }
      })();
    }
    await this.initialized; return { ...this.state };
  }
  async prepare() {
    await this.getState();
    if (this.preparing) return this.preparing;
    if (this.state.ready) return this.getState();
    this.controller = new AbortController();
    this.update({ phase: 'downloading', error: null, percent: 0 });
    this.preparing = (async () => {
      const zip = path.join(this.directory, 'runtime.zip');
      try {
        await downloadAsset(RUNTIME, zip, this.fetcher, this.controller.signal, count => this.update({ percent: Math.round(count / (RUNTIME.size + MODEL.size) * 100) }));
        if (!fs.existsSync(this.executable)) {
          const stage = path.join(this.directory, `runtime-${randomUUID()}`);
          try {
            await extract(zip, { dir: stage, onEntry: entry => { if (entry.fileName.includes('..') || path.isAbsolute(entry.fileName)) throw new Error('语音引擎包包含无效路径。'); } });
            if (!fs.existsSync(path.join(stage, 'Release', 'whisper-cli.exe'))) throw new Error('语音引擎包不完整。');
            await fsp.rename(stage, path.join(this.directory, 'runtime'));
          } finally { if (path.dirname(path.resolve(stage)) === path.resolve(this.directory)) await fsp.rm(stage, { recursive: true, force: true }); }
        }
        await downloadAsset(MODEL, this.model, this.fetcher, this.controller.signal, count => this.update({ percent: Math.round((RUNTIME.size + count) / (RUNTIME.size + MODEL.size) * 100) }));
        this.update({ phase: 'ready', ready: true, percent: 100, error: null });
      } catch (error) {
        this.update({ phase: 'error', error: this.controller.signal.aborted ? '下载已暂停，下次可继续。' : error.message });
        throw error;
      } finally { this.preparing = null; }
      return { ...this.state };
    })();
    return this.preparing;
  }
  cancel(mode = 'all') { if (mode !== 'recognition') this.controller?.abort(); if (mode !== 'download') { this.recognitionAbort?.abort(); this.recognizer?.kill(); } }
  async transcribe(audio, language = 'auto') {
    await this.getState();
    if (!this.state.ready) throw new Error('请先下载本地语音模型。');
    if (this.recognitionBusy) throw new Error('正在识别上一段录音，请稍后。');
    if (!['auto', 'zh', 'en'].includes(language)) throw new Error('无效的语音语言。');
    const bytes = validateAudio(audio);
    this.recognitionBusy = true; this.recognitionAbort = new AbortController();
    const id = randomUUID();
    const wav = path.join(this.directory, 'recordings', id + '.wav');
    const output = path.join(this.directory, 'recordings', id + '.txt');
    this.update({ phase: 'transcribing', error: null });
    try {
      await fsp.mkdir(path.join(this.directory, 'recordings'), { recursive: true });
      await fsp.writeFile(wav, bytes, { mode: 0o600, flag: 'wx' });
      if (this.recognitionAbort.signal.aborted) throw new Error('识别已取消。');
      await new Promise((resolve, reject) => {
        // ASCII relative arguments also work when the Windows profile name
        // contains Chinese characters; Node supplies the Unicode cwd natively.
        const child = spawn(this.executable, ['-m', 'model.bin', '-f', `recordings/${id}.wav`, '-of', `recordings/${id}`, '-otxt', '-np', '-nt', '-ng', '-l', language, '-t', String(Math.min(4, Math.max(1, os.availableParallelism() - 2)))], { cwd: this.directory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: this.recognitionAbort.signal });
        this.recognizer = child;
        let errorText = '', failure = '';
        child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
        const timeout = setTimeout(() => { failure = '识别超时，请缩短录音后重试。'; child.kill(); }, 10 * 60 * 1000);
        child.on('error', error => { failure = error.name === 'AbortError' ? '识别已取消。' : error.message; });
        child.on('close', code => { clearTimeout(timeout); if (code === 0 && !failure) resolve(); else reject(new Error(failure || (code === null ? '识别已取消。' : `本地识别失败（${code}）：${errorText.trim()}`))); });
      });
      const text = (await fsp.readFile(output, 'utf8')).trim();
      if (!text) throw new Error('没有识别到文字，请靠近麦克风重试。');
      this.update({ phase: 'ready' }); return text;
    } catch (error) { this.update({ phase: 'ready', error: error.message }); throw error; }
    finally { this.recognitionBusy = false; this.recognizer = null; this.recognitionAbort = null; await fsp.unlink(wav).catch(() => {}); await fsp.unlink(output).catch(() => {}); }
  }
  close() { this.cancel(); }
}
module.exports = { VoiceManager, RUNTIME, MODEL, digest, downloadAsset, validateAudio };
