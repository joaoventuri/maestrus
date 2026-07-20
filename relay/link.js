'use strict';
// RelayLink — cliente WS reutilizável do Maestrus remoto.
// Usado pelo HOST (Electron), pelo CLIENT desktop (Electron) e pelo MOBILE
// (Capacitor/browser). Agnóstico de ambiente: recebe a impl de WebSocket
// (global no browser, pacote `ws` no Node/Electron).
//
// Recursos: RPC com correlação por reqId + timeout, streaming de eventos,
// presença, registro de host e RECONEXÃO com backoff (re-registra o host).

const { frame, parseFrame, FRAME } = require('./protocol');

function resolveWS(impl) {
  if (impl) return impl;
  if (typeof globalThis !== 'undefined' && globalThis.WebSocket) return globalThis.WebSocket;
  try { return require('ws'); } catch { throw new Error('RelayLink: sem implementação de WebSocket'); }
}

class RelayLink {
  // opts: { url, token, deviceId, role, WebSocketImpl, hostInfo,
  //         onEvent(f), onPresence(f), onRpcRequest(f, reply), onStatus(s), logger,
  //         refreshTokenFn(): Promise<string|null> — chamada ANTES de cada
  //         reconnect; se devolver string, vira o novo token no URL. Sem isso,
  //         o WS reabria com o token cacheado (que pode ter expirado) e o
  //         relay devolveria 4001 → loop infinito de connect → backoff. }
  constructor(opts) {
    this.opts = opts;
    this.WS = resolveWS(opts.WebSocketImpl);
    this.ws = null;
    this.pending = new Map();   // reqId → { resolve, reject, timer }
    this.seq = 0;
    this.closed = false;
    this.backoff = 500;
    this.status = 'idle';
    this.logger = opts.logger || console;
    this._lastRecvAt = 0;       // timestamp do último frame recebido
    this._hbTimer = null;       // timer do heartbeat (ping periódico)
    this._deadTimer = null;     // timer que dispara se não recebemos pong
  }

  connect() {
    if (this.closed) return;
    const { url, token } = this.opts;
    const full = `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    let ws;
    try { ws = new this.WS(full); } catch (e) { this._setStatus('error'); this._scheduleReconnect(); return; }
    this.ws = ws;

    const onOpen = () => {
      this.backoff = 500;
      this._lastRecvAt = Date.now();
      this._setStatus('online');
      if (this.opts.role === 'host' && this.opts.hostInfo) {
        this.registerHost(this.opts.hostInfo);
      }
      this._startHeartbeat();
    };
    const onMessage = (raw) => {
      const data = raw && raw.data !== undefined ? raw.data : raw; // browser Event vs ws
      this._lastRecvAt = Date.now();
      // qualquer frame conta como sinal de vida — cancela o dead timer
      if (this._deadTimer) { clearTimeout(this._deadTimer); this._deadTimer = null; }
      const f = parseFrame(data);
      if (f) this._onFrame(f);
    };
    const onClose = () => { this._stopHeartbeat(); this._setStatus('offline'); this._failAllPending('connection-closed'); if (!this.closed) this._scheduleReconnect(); };
    const onError = () => { this._setStatus('error'); };

    // browser (addEventListener) vs ws (on)
    if (ws.addEventListener) {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    } else {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
    }
  }

  _scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(this.backoff, 15000);
    this.backoff = Math.min(this.backoff * 2, 15000);
    setTimeout(async () => {
      if (this.closed) return;
      // Token fresco ANTES de reconectar (fix: TTL de 10min + relay reinicia
      // num momento ruim resultava em loop com token velho).
      if (this.opts.refreshTokenFn) {
        try {
          const t = await this.opts.refreshTokenFn();
          if (t) this.opts.token = t;
        } catch {}
      }
      this.connect();
    }, delay);
  }

  _setStatus(s) { if (s !== this.status) { this.status = s; this.opts.onStatus?.(s); } }

  // Heartbeat app-level: manda PING a cada 20s e derruba o socket se não recebe
  // NADA (pong OU qualquer outro frame) em 45s. Cobre o caso do notebook dormir
  // e acordar — o OS matou o WS mas o Electron não recebeu 'close' porque estava
  // suspenso, então internamente ficamos "online" mas nada trafega.
  _startHeartbeat() {
    this._stopHeartbeat();
    this._hbTimer = setInterval(() => {
      if (!this.ws || this.status !== 'online') return;
      // manda PING sem esperar resposta correlacionada — só serve pra receber PONG
      // (que atualiza _lastRecvAt).
      try { this.ws.send(frame(FRAME.PING, {})); } catch {}
      // se 45s sem receber NADA, socket tá morto na prática — force close pra
      // disparar reconnect via onClose.
      const silentFor = Date.now() - this._lastRecvAt;
      if (silentFor > 45000) {
        try { this.logger.warn('[relay-link] sem frames por ' + silentFor + 'ms — force close pra reconectar'); } catch {}
        try { this.ws.close(4008, 'heartbeat-dead'); } catch {}
        // fallback: se o close também não dispara (WS realmente zumbi), força
        // teardown + reconnect manual.
        setTimeout(() => {
          if (this.status === 'online' && !this.closed) {
            this._setStatus('offline'); this._failAllPending('heartbeat-forced');
            this._scheduleReconnect();
          }
        }, 2000);
      }
    }, 20000);
    if (this._hbTimer.unref) this._hbTimer.unref();
  }
  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (this._deadTimer) { clearTimeout(this._deadTimer); this._deadTimer = null; }
  }

  // "Vivo": recebeu algum frame nos últimos N segundos. Usado por callers que
  // querem checar saúde do link antes de fazer teardown (evita reconnect
  // desnecessário quando o link tá 100% ok).
  isHealthy(maxAgeMs = 30000) {
    if (this.status !== 'online') return false;
    if (!this._lastRecvAt) return false;
    return (Date.now() - this._lastRecvAt) < maxAgeMs;
  }

  // Força uma reconexão imediata — usado quando o processo acorda de suspend
  // e queremos garantir socket fresco em vez de confiar no estado interno.
  forceReconnect() {
    if (this.closed) return;
    this._stopHeartbeat();
    try { this.ws && this.ws.close(4009, 'force-reconnect'); } catch {}
    this._setStatus('offline');
    this._failAllPending('force-reconnect');
    this.backoff = 500;
    // reconnect imediato (sem esperar backoff)
    setTimeout(() => { if (!this.closed) this.connect(); }, 100);
  }

  _send(type, fields) {
    try { this.ws.send(frame(type, fields)); return true; } catch { return false; }
  }

  _onFrame(f) {
    switch (f.type) {
      case FRAME.RPC_RESPONSE: {
        const p = this.pending.get(f.reqId);
        if (p) { clearTimeout(p.timer); this.pending.delete(f.reqId); p.resolve(f.payload); }
        return;
      }
      case FRAME.ERROR: {
        if (f.reqId && this.pending.has(f.reqId)) {
          const p = this.pending.get(f.reqId); clearTimeout(p.timer); this.pending.delete(f.reqId); p.reject(new Error(f.error || 'relay-error'));
        }
        return;
      }
      case FRAME.RPC_REQUEST: {
        if (this.opts.onRpcRequest) {
          const reply = (payload) => this._send(FRAME.RPC_RESPONSE, { to: f.from, reqId: f.reqId, payload });
          const fail = (error) => this._send(FRAME.ERROR, { to: f.from, reqId: f.reqId, error: String(error) });
          this.opts.onRpcRequest(f, reply, fail);
        }
        return;
      }
      case FRAME.EVENT: this.opts.onEvent?.(f); return;
      case FRAME.PRESENCE: this.opts.onPresence?.(f); return;
      case FRAME.HOST_LIST: {
        const p = this.pending.get('__hostlist__');
        if (p) { clearTimeout(p.timer); this.pending.delete('__hostlist__'); p.resolve(f.payload?.hosts || []); }
        return;
      }
      case FRAME.PONG: return; // já contamos como frame recebido em onMessage
      case FRAME.PING: { try { this._send(FRAME.PONG, {}); } catch {} return; }
      default: return;
    }
  }

  _failAllPending(reason) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  // ─── client ───────────────────────────────────────────────────────────────
  rpc(to, channel, payload, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const reqId = `${Date.now()}-${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error('rpc-timeout')); }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      if (!this._send(FRAME.RPC_REQUEST, { to, reqId, channel, payload })) {
        clearTimeout(timer); this.pending.delete(reqId); reject(new Error('send-failed'));
      }
    });
  }

  hostList(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete('__hostlist__'); reject(new Error('hostlist-timeout')); }, timeoutMs);
      this.pending.set('__hostlist__', { resolve, reject, timer });
      this._send(FRAME.HOST_LIST, {});
    });
  }

  // ─── host ───────────────────────────────────────────────────────────────
  registerHost(info) { this.opts.hostInfo = info; return this._send(FRAME.REGISTER_HOST, { payload: info }); }
  sendEvent(to, channel, payload) { return this._send(FRAME.EVENT, { to, channel, payload }); }

  close() { this.closed = true; this._stopHeartbeat(); this._failAllPending('closed'); try { this.ws?.close(); } catch {} }
}

module.exports = { RelayLink };
