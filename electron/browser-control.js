// Controle do navegador embutido (o <webview> do painel de preview) pelo main
// process. Expõe operações que o MCP usa pra dirigir a página: navegar, ler,
// snapshot de elementos, clicar, digitar, screenshot, voltar/avançar/recarregar
// e eval. O main captura o webContents "guest" do <webview> via
// did-attach-webview e opera direto nele.

let guest = null;     // webContents do <webview>
let mainWin = null;
let waiters = [];

function setMainWindow(win) {
  mainWin = win;
  win.webContents.on('did-attach-webview', (_e, wc) => {
    guest = wc;
    // links target=_blank dentro da página navegam no próprio guest (sem popup)
    try { wc.setWindowOpenHandler(({ url }) => { try { wc.loadURL(url); } catch {} return { action: 'deny' }; }); } catch {}
    wc.on('destroyed', () => { if (guest === wc) guest = null; });
    const w = waiters; waiters = []; w.forEach((fn) => fn(wc));
  });
}

function waitAttach(timeoutMs = 8000) {
  if (guest && !guest.isDestroyed()) return Promise.resolve(guest);
  return new Promise((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => reject(new Error('o painel do navegador não abriu (timeout)')), timeoutMs);
  });
}

// Garante que o painel está aberto (webview montado) e retorna o guest.
async function ensureGuest() {
  if (guest && !guest.isDestroyed()) return guest;
  if (!mainWin || mainWin.isDestroyed()) throw new Error('janela não está pronta');
  mainWin.webContents.send('browser:open', { url: 'about:blank' });
  return waitAttach();
}

function settle(ms) { return new Promise((r) => setTimeout(r, ms)); }

function onceStop(wc, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    wc.once('did-stop-loading', fin);
    setTimeout(fin, timeoutMs);
  });
}

function current() {
  if (!guest || guest.isDestroyed()) return { url: null, title: null };
  return { url: guest.getURL(), title: guest.getTitle() };
}

function finderJs(args) {
  if (args.selector) return `document.querySelector(${JSON.stringify(args.selector)})`;
  return `document.querySelector('[data-maestrus-ref="' + ${JSON.stringify(String(args.ref))} + '"]')`;
}

const ops = {
  async navigate(args) {
    let url = String(args.url || '').trim();
    if (!url) throw new Error('url vazia');
    if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    const g = await ensureGuest();
    const stop = onceStop(g);
    try { await g.loadURL(url); } catch { /* redirects/abort podem rejeitar; segue */ }
    await stop;
    return current();
  },

  async current() { return current(); },

  async read(args) {
    const g = await ensureGuest();
    const max = Number(args.max) || 12000;
    const t = await g.executeJavaScript('document.body ? document.body.innerText : ""', true);
    return { text: String(t || '').slice(0, max), ...current() };
  },

  async html(args) {
    const g = await ensureGuest();
    const max = Number(args.max) || 20000;
    const h = await g.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""', true);
    return { html: String(h || '').slice(0, max) };
  },

  // Lista elementos interativos com um "ref" estável (data-maestrus-ref) p/ clicar.
  async snapshot(args) {
    const g = await ensureGuest();
    const max = Number(args.max) || 150;
    const js = `(() => {
      const out = [];
      const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [contenteditable=true]';
      let i = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (i >= ${max}) break;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        el.setAttribute('data-maestrus-ref', String(i));
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
        const item = { ref: i, tag, text };
        if (el.getAttribute('href')) item.href = el.href;
        if (el.type) item.type = el.type;
        out.push(item);
        i++;
      }
      return out;
    })()`;
    const items = await g.executeJavaScript(js, true);
    return { elements: items, ...current() };
  },

  async click(args) {
    const g = await ensureGuest();
    const js = `(() => { const el = ${finderJs(args)}; if (!el) return { ok:false, error:'elemento não encontrado' }; el.scrollIntoView({block:'center'}); el.click(); return { ok:true }; })()`;
    const r = await g.executeJavaScript(js, true);
    await settle(600); // deixa eventual navegação/JS assentar
    return { ...r, ...current() };
  },

  async type(args) {
    const g = await ensureGuest();
    const text = JSON.stringify(String(args.text ?? ''));
    const submit = args.submit
      ? `const f = el.form; if (f) { (f.requestSubmit ? f.requestSubmit() : f.submit()); }`
      : '';
    const js = `(() => { const el = ${finderJs(args)}; if (!el) return { ok:false, error:'não encontrado' }; el.focus(); if ('value' in el) { el.value = ${text}; } else { el.textContent = ${text}; } el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); ${submit} return { ok:true }; })()`;
    const r = await g.executeJavaScript(js, true);
    await settle(args.submit ? 900 : 200);
    return { ...r, ...current() };
  },

  async screenshot() {
    const g = await ensureGuest();
    const img = await g.capturePage();
    const size = img.getSize();
    return { base64: img.toPNG().toString('base64'), width: size.width, height: size.height };
  },

  async back() {
    const g = await ensureGuest();
    if (g.canGoBack()) { const s = onceStop(g); g.goBack(); await s; }
    return current();
  },
  async forward() {
    const g = await ensureGuest();
    if (g.canGoForward()) { const s = onceStop(g); g.goForward(); await s; }
    return current();
  },
  async reload() {
    const g = await ensureGuest();
    const s = onceStop(g); g.reload(); await s;
    return current();
  },

  async eval(args) {
    const g = await ensureGuest();
    const v = await g.executeJavaScript(`(async () => { try { return JSON.stringify(await (async()=>{ return (${args.js}); })()); } catch (e) { return JSON.stringify({ __error: String(e && e.message || e) }); } })()`, true);
    return { result: v };
  },

  async wait(args) {
    await settle(Math.min(Number(args.ms) || 1000, 15000));
    return current();
  },
};

async function run(op, args) {
  const fn = ops[op];
  if (typeof fn !== 'function') throw new Error('op desconhecida: ' + op);
  return fn(args || {});
}

module.exports = { setMainWindow, run };
