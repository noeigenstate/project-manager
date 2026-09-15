import { useEffect, useRef, useState } from 'react';
import { Microphone, Stop, Copy, DownloadSimple, X, SpinnerGap } from '@phosphor-icons/react';
import { MicrophoneCapture } from './voice-audio';
import type { VoiceState } from './types';

export function VoiceDialog({ target, close }: { target: { id: string; sessionId: string | null; name: string } | null; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), meter = useRef<HTMLDivElement>(null);
  const capture = useRef(new MicrophoneCapture());
  const alive = useRef(true);
  const [state, setState] = useState<VoiceState | null>(null), [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState(''), [language, setLanguage] = useState('auto');
  const [listening, setListening] = useState(false), [recording, setRecording] = useState(false), [busy, setBusy] = useState(false);
  const [text, setText] = useState(''), [error, setError] = useState(''), [seconds, setSeconds] = useState(0);
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const stopping = useRef(false);
  const resetMeter = () => { if (meter.current) { meter.current.style.setProperty('--voice-level', '0%'); meter.current.setAttribute('aria-valuenow', '0'); } };
  useEffect(() => {
    dialog.current?.showModal(); alive.current = true;
    const off = window.projectGrid.onVoiceState(value => { if (alive.current) setState(value); });
    const hidden = () => { if (document.hidden && capture.current.stream) { void capture.current.close(); setRecording(false); setListening(false); resetMeter(); setError('窗口隐藏后已停止麦克风，可重新录音。'); } };
    document.addEventListener('visibilitychange', hidden);
    window.projectGrid.getVoiceState().then(result => { if (result.ok && alive.current) setState(result.value); });
    return () => { alive.current = false; off(); document.removeEventListener('visibilitychange', hidden); void capture.current.close(); void window.projectGrid.cancelVoice(); };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds(value => value + 1), 1000); return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => { if (recording && seconds >= 300) void stopRef.current(); }, [seconds, recording]);
  const micError = (error: unknown) => {
    const name = (error as DOMException).name;
    return name === 'NotAllowedError' ? '麦克风访问被拒绝，请在 Windows 设置中允许桌面应用使用麦克风。' : name === 'NotFoundError' ? '没有找到麦克风，请连接设备后重试。' : name === 'NotReadableError' ? '麦克风无法使用，可能正被其他程序独占。' : String((error as Error).message || error);
  };
  const detect = async () => {
    setError(''); setBusy(true);
    try {
      await capture.current.open(device, level => { if (meter.current) { const percent = Math.round(Math.min(1, level * 5) * 100); meter.current.style.setProperty('--voice-level', `${percent}%`); meter.current.setAttribute('aria-valuenow', String(percent)); } });
      if (!alive.current) { await capture.current.close(); return; }
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')); setListening(true);
    } catch (error) { if (alive.current) setError(micError(error)); }
    finally { if (alive.current) setBusy(false); }
  };
  const start = async () => {
    if (!listening) await detect();
    if (!capture.current.stream || !alive.current) return;
    capture.current.onLimit = () => { void stopRef.current(); }; capture.current.startRecording(); setSeconds(0); setRecording(true); setError('');
  };
  const stop = async () => {
    if (!recording || stopping.current) return;
    stopping.current = true;
    setRecording(false); setBusy(true); setError('');
    try {
      const wav = await capture.current.stopRecording(); await capture.current.close(); setListening(false); resetMeter();
      if (!alive.current) return;
      const result = await window.projectGrid.transcribe(wav, language);
      if (!result.ok) throw new Error(result.error);
      if (alive.current) setText(previous => previous ? previous + '\n' + result.value : result.value);
    } catch (error) { if (alive.current) setError(micError(error)); }
    finally { await capture.current.close(); stopping.current = false; if (alive.current) { setBusy(false); setListening(false); resetMeter(); } }
  };
  stopRef.current = stop;
  const setup = async () => { setError(''); const result = await window.projectGrid.prepareVoice(); if (!result.ok && alive.current) setError(result.error); };
  const insert = async () => {
    if (!target?.sessionId) return;
    const result = await window.projectGrid.pasteTerminal(target.id, text, target.sessionId);
    if (!result.ok) setError(result.error); else close();
  };
  return <dialog ref={dialog} className="settings-dialog voice-dialog" onCancel={close}><div className="dialog-content">
    <div className="dialog-heading"><h2><Microphone size={22} />语音输入</h2><button className="icon-button" aria-label="关闭语音输入" onClick={close}><X size={18} /></button></div>
    <p className="project-add-note">本地识别，录音不上传。{target ? `插入“${target.name}”的终端后，由你确认发送。` : '可检测麦克风、识别并复制文字。'}</p>
    {!state?.ready && <div className="voice-model"><b>首次使用需下载离线模型</b><p>语音引擎与多语言模型约 64 MB，支持断点续传。</p>
      {state?.phase === 'downloading' ? <><progress aria-label="语音模型下载进度" max={100} value={state.percent} /><span>{state.percent}%</span><button className="text-button" onClick={() => void window.projectGrid.cancelVoice('download')}>暂停下载</button></>
        : <button className="button secondary small" onClick={() => void setup()}><DownloadSimple size={15} />下载本地语音模型</button>}
    </div>}
    <div className="voice-device"><label>麦克风<select aria-label="麦克风设备" value={device} disabled={recording || busy} onChange={async event => { setDevice(event.target.value); await capture.current.close(); setListening(false); resetMeter(); }}><option value="">系统默认麦克风</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || '麦克风'}</option>)}</select></label>
      <label>语言<select aria-label="识别语言" value={language} disabled={recording || busy} onChange={event => setLanguage(event.target.value)}><option value="auto">自动识别</option><option value="zh">中文</option><option value="en">English</option></select></label></div>
    <div className="voice-meter" ref={meter} role="progressbar" aria-label="麦克风音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}><span /></div>
    <div className="voice-controls"><button className="button secondary small" disabled={recording || busy} onClick={() => { if (listening) { void capture.current.close(); setListening(false); resetMeter(); } else void detect(); }}>{listening ? '停止检测' : '检测麦克风'}</button>
      <span role="status">{recording ? `录音中 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : busy ? '正在处理…' : listening ? '麦克风已连接，请说话查看音量' : ''}</span>
      <button className={`button ${recording ? 'secondary' : 'primary'} small`} disabled={!state?.ready || busy || state?.phase === 'transcribing'} onClick={() => void (recording ? stop() : start())}>{recording ? <Stop size={15} weight="fill" /> : <Microphone size={15} />}{recording ? '停止并识别' : '开始录音'}</button>
    </div>
    {(error || state?.phase === 'error' && state.error) && <p className="form-error" role="alert">{error || state?.error}</p>}
    {state?.phase === 'transcribing' && <p className="voice-processing"><SpinnerGap className="loading-spinner" size={16} />正在本机转成文字…<button className="text-button" onClick={() => void window.projectGrid.cancelVoice()}>取消</button></p>}
    <textarea className="voice-transcript" aria-label="识别文字" placeholder="识别结果会显示在这里，可编辑后再插入终端。" value={text} onChange={event => setText(event.target.value)} rows={5} />
    <div className="dialog-footer"><button className="text-button" disabled={!text.trim()} onClick={() => void window.projectGrid.copy(text)}><Copy size={15} />复制文字</button><button className="button primary" disabled={!text.trim() || !target?.sessionId || recording || busy} onClick={() => void insert()}>插入终端</button></div>
  </div></dialog>;
}
