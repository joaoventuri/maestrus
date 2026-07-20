// Cliente renderer da OpenAI Realtime API (via main process).
// - Captura mic em PCM16 24kHz mono, manda em chunks base64 pra main.
// - Recebe deltas de áudio base64 PCM16 e reproduz via AudioBufferSourceNode.
// - Expõe transcrições, eventos de tool e status.

const M = () => (window as any).maestrus;

export interface RealtimeStatus {
  status: 'idle' | 'connecting' | 'connected' | 'closed' | 'error';
  message?: string;
}

export interface RealtimeOpts {
  projectId?: string;
  lang?: 'en' | 'pt' | 'es';
  onStatus?: (s: RealtimeStatus) => void;
  onUserText?: (text: string, done: boolean) => void;
  onAssistantText?: (text: string, done: boolean) => void;
  onToolCall?: (name: string, callId: string) => void;
  onToolResult?: (name: string, ok: boolean, error?: string) => void;
  onAudioLevel?: (rms: number) => void;
}

export class RealtimeSession {
  private audioCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private offEvent: (() => void) | null = null;
  private active = false;
  private playbackQueueTime = 0;
  private opts: RealtimeOpts;

  constructor(opts: RealtimeOpts) { this.opts = opts; }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.active) return { ok: true };
    this.opts.onStatus?.({ status: 'connecting' });

    // Inicia a sessão no main (abre WebSocket com OpenAI).
    const r: any = await M()?.realtime?.start({ projectId: this.opts.projectId, lang: this.opts.lang });
    if (!r?.ok) {
      this.opts.onStatus?.({ status: 'error', message: r?.error || 'failed_to_start' });
      return { ok: false, error: r?.error };
    }

    this.offEvent = M()?.realtime?.onEvent?.((ch: string, payload: any) => {
      if (ch === 'realtime:status') {
        if (payload?.status === 'connected') this.opts.onStatus?.({ status: 'connected' });
        else if (payload?.status === 'closed') { this.opts.onStatus?.({ status: 'closed' }); this.cleanup(); }
        else if (payload?.status === 'error') this.opts.onStatus?.({ status: 'error', message: payload?.message });
      } else if (ch === 'realtime:transcript') {
        if (payload.kind === 'user') this.opts.onUserText?.(payload.text || payload.delta || '', !!payload.done);
        if (payload.kind === 'assistant') this.opts.onAssistantText?.(payload.text || payload.delta || '', !!payload.done);
      } else if (ch === 'realtime:audio') {
        if (payload?.delta) this.playAudioChunk(payload.delta);
      } else if (ch === 'realtime:event') {
        if (payload?.type === 'tool_call') this.opts.onToolCall?.(payload.name, payload.callId);
        else if (payload?.type === 'tool_result') this.opts.onToolResult?.(payload.name, !!payload.ok, payload.error);
      }
    });

    try { await this.startMic(); } catch (e: any) {
      this.opts.onStatus?.({ status: 'error', message: 'mic_denied: ' + (e?.message || e) });
      this.cleanup(); return { ok: false, error: 'mic_denied' };
    }
    this.active = true;
    return { ok: true };
  }

  // 24kHz PCM16 mono é o formato esperado pela Realtime API.
  private async startMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 24000 },
    });
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new AC({ sampleRate: 24000 });
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    // ScriptProcessor: deprecated mas funciona em Electron e dá controle bruto sobre samples.
    // 4096 samples @ 24kHz ≈ 170ms — bom equilíbrio entre latência e overhead.
    this.workletNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.workletNode.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      // Mede RMS pra animação
      let sum = 0; for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      this.opts.onAudioLevel?.(rms);
      // Converte Float32 → PCM16
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const b64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
      M()?.realtime?.appendAudio(b64);
    };
    this.source.connect(this.workletNode);
    this.workletNode.connect(this.audioCtx.destination);
  }

  // Decodifica base64 PCM16 → Float32 e agenda playback contínuo.
  private async playAudioChunk(b64: string) {
    if (!this.playbackCtx) {
      const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.playbackCtx = new AC({ sampleRate: 24000 });
      this.playbackQueueTime = this.playbackCtx!.currentTime;
    }
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
      const buf = this.playbackCtx!.createBuffer(1, float32.length, 24000);
      buf.getChannelData(0).set(float32);
      const src = this.playbackCtx!.createBufferSource();
      src.buffer = buf;
      src.connect(this.playbackCtx!.destination);
      const now = this.playbackCtx!.currentTime;
      const start = Math.max(this.playbackQueueTime, now);
      src.start(start);
      this.playbackQueueTime = start + buf.duration;
    } catch (e) { /* ignore decode errors */ }
  }

  // Interrompe a IA mid-fala e libera o turno pro usuário.
  async interrupt() {
    await M()?.realtime?.cancelResponse?.();
    if (this.playbackCtx) {
      try { await this.playbackCtx.close(); } catch {}
      this.playbackCtx = null; this.playbackQueueTime = 0;
    }
  }

  async sendText(text: string) {
    await M()?.realtime?.sendText?.(text);
  }

  async stop() {
    this.active = false;
    try { await M()?.realtime?.stop?.(); } catch {}
    this.cleanup();
  }

  private cleanup() {
    try { this.workletNode && this.workletNode.disconnect(); } catch {}
    try { this.source && this.source.disconnect(); } catch {}
    try { this.audioCtx && this.audioCtx.close(); } catch {}
    try { this.playbackCtx && this.playbackCtx.close(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.offEvent && this.offEvent(); } catch {}
    this.workletNode = null; this.source = null; this.audioCtx = null; this.playbackCtx = null; this.stream = null;
    this.offEvent = null; this.playbackQueueTime = 0;
  }
}
