class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(4096); this.used = 0;
    this.port.onmessage = event => { if (event.data === 'flush') { this.send(); this.port.postMessage({ flushed: true }); } };
  }
  send() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    let energy = 0; for (const value of samples) energy += value * value;
    this.port.postMessage({ samples, level: Math.sqrt(energy / samples.length) }, [samples.buffer]);
    this.used = 0;
  }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length; index++) {
      let value = 0; for (const channel of channels) value += channel[index];
      this.buffer[this.used++] = value / channels.length;
      if (this.used === this.buffer.length) this.send();
    }
    return true;
  }
}
registerProcessor('project-grid-voice', VoiceCaptureProcessor);
