'use strict';
// maestrus-agent — serviço mínimo que executa docker no VPS-host.
//
// Roda como container próprio com /var/run/docker.sock montado, na rede interna
// (maestrus). O app PHP (control plane) chama http://maestrus-agent:8791/provision
// autenticado por X-Agent-Token. Isolado do container web-facing por design:
// se o PHP for comprometido, o atacante ainda precisa do token pra falar com o
// agent, e o agent só aceita um conjunto FECHADO de operações docker.
//
// Segurança:
//  - Token obrigatório (MAESTRUS_AGENT_TOKEN), comparado com timing-safe.
//  - Só executa `docker` com argumentos que ele mesmo monta a partir de campos
//    validados — nunca eval de string arbitrária do cliente.
//  - Nome de container/volume restrito a [a-z0-9-] (regex).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Dir dos snippets Caddy dos tenants (montado do host). Ao escrever/remover,
// recarrega o Caddy do host via docker exec no container caddy OU signal.
const CADDY_TENANTS_DIR = process.env.MAESTRUS_CADDY_TENANTS_DIR || '/caddy-tenants';
const CADDY_RELOAD_CMD = process.env.MAESTRUS_CADDY_RELOAD || ''; // ex: "systemctl reload caddy" via nsenter

const PORT = parseInt(process.env.MAESTRUS_AGENT_PORT || '8791', 10);
const TOKEN = process.env.MAESTRUS_AGENT_TOKEN || '';
const IMAGE_DEFAULT = process.env.MAESTRUS_CONTAINER_IMAGE || 'ghcr.io/joaoventuri/maestrus-server:latest';

if (!TOKEN) { console.error('[agent] MAESTRUS_AGENT_TOKEN obrigatório'); process.exit(1); }

function tokenOk(got) {
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
// Hostname de domínio próprio (plano Pro): labels válidos + TLD alfabético.
// Nunca vai pra shell — só compõe o snippet Caddy escrito via fs.
const SAFE_DOMAIN = /^(?=.{4,190}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
// Snippet do domínio custom mora em arquivo próprio custom-u{id}.caddy.
const SAFE_CUSTOM_FILE = /^custom-[a-z0-9-]{1,60}\.caddy$/;

async function caddyReload() {
  if (!CADDY_RELOAD_CMD) return false; // sem comando: o path unit do systemd observa o dir e recarrega
  return new Promise((resolve) => {
    execFile('sh', ['-c', CADDY_RELOAD_CMD], { timeout: 20000 }, (e) => resolve(!e));
  });
}

function docker(args) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: 120000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '') + (stderr || '') });
    });
  });
}

async function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!tokenOk(req.headers['x-agent-token'])) return send(403, { ok: false, error: 'forbidden' });

  const url = new URL(req.url, 'http://x');
  const body = req.method === 'POST' ? await readJson(req) : {};
  const op = url.pathname.replace(/^\//, '');

  try {
    switch (op) {
      case 'provision': {
        const name = String(body.name || '');
        const image = String(body.image || IMAGE_DEFAULT);
        const port = parseInt(body.host_port, 10);
        const mem = String(body.mem_limit || '4g');
        const cpus = String(body.cpu_limit || '2');
        const env = body.env && typeof body.env === 'object' ? body.env : {};
        const volume = String(body.volume || '');
        const network = String(body.network || 'maestrus');
        if (!SAFE_NAME.test(name)) return send(400, { ok: false, error: 'bad_name' });
        if (!(port >= 1024 && port <= 65535)) return send(400, { ok: false, error: 'bad_port' });
        if (volume && !SAFE_NAME.test(volume)) return send(400, { ok: false, error: 'bad_volume' });

        // remove container homônimo (re-provision limpo)
        await docker(['rm', '-f', name]);

        const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped',
          '--label', 'maestrus.user=' + name,
          '--network', network,
          '--memory', mem, '--cpus', cpus,
          '-p', `127.0.0.1:${port}:8090`];
        if (volume) args.push('-v', `${volume}:/data`);
        for (const [k, v] of Object.entries(env)) {
          if (/^[A-Z0-9_]+$/.test(k)) args.push('-e', `${k}=${v}`);
        }
        args.push(image);

        const r = await docker(args);
        if (r.code !== 0) return send(500, { ok: false, error: 'docker_run_failed', detail: r.out.slice(0, 1000) });

        // Egresso dedicado: conecta o container à rede IPv6 routed com seu IPv6
        // exclusivo. Cada tenant sai pra internet com IP próprio (o ndppd do host
        // responde NDP pro prefixo /80). Best-effort — nunca falha o provision.
        let egressAttached = false;
        const egressNet = String(body.egress_net || '');
        const egressIp6 = String(body.egress_ip6 || '');
        const egressPrefix = String(body.egress_prefix || '');
        if (egressNet && egressIp6 && /^[a-z0-9_-]+$/i.test(egressNet) && /^[0-9a-f:]+$/i.test(egressIp6)) {
          try {
            const net = await docker(['network', 'inspect', egressNet]);
            if (net.code !== 0 && /^[0-9a-f:]+$/i.test(egressPrefix)) {
              await docker(['network', 'create', '--ipv6', '--subnet', egressPrefix + '::/80',
                '-o', 'com.docker.network.bridge.gateway_mode_ipv6=routed', egressNet]);
            }
            await docker(['network', 'disconnect', egressNet, name]); // ignora erro se não estava conectado
            const cn = await docker(['network', 'connect', '--ip6', egressIp6, egressNet, name]);
            egressAttached = (cn.code === 0);
          } catch (e) { /* egresso é best-effort */ }
        }

        // Escreve o snippet Caddy do tenant + recarrega (roteamento por subdomínio).
        let caddyReloaded = false;
        const snippet = String(body.caddy_snippet || '');
        const caddyFile = String(body.caddy_file || '');
        if (snippet && /^[a-z0-9._-]+\.caddy$/.test(caddyFile)) {
          try {
            fs.mkdirSync(CADDY_TENANTS_DIR, { recursive: true });
            fs.writeFileSync(path.join(CADDY_TENANTS_DIR, caddyFile), snippet);
            if (CADDY_RELOAD_CMD) {
              const rl = await new Promise((resolve) => {
                execFile('sh', ['-c', CADDY_RELOAD_CMD], { timeout: 20000 }, (e) => resolve(!e));
              });
              caddyReloaded = rl;
            } else {
              // Sem comando de reload configurado: reload via docker exec no caddy do host
              // não se aplica (Caddy é systemd). O snippet fica escrito; o host recarrega
              // via watcher/cron OU o reload é feito pelo container_report. Marca como escrito.
              caddyReloaded = false;
            }
          } catch (e) { /* snippet write falhou — container já subiu, loga */ }
        }
        return send(200, { ok: true, container_id: r.out.trim(), caddy_reloaded: caddyReloaded, egress_attached: egressAttached });
      }
      case 'stop': {
        const name = String(body.name || '');
        if (!SAFE_NAME.test(name)) return send(400, { ok: false, error: 'bad_name' });
        const r = await docker(['stop', name]);
        return send(200, { ok: r.code === 0, out: r.out });
      }
      case 'start': {
        const name = String(body.name || '');
        if (!SAFE_NAME.test(name)) return send(400, { ok: false, error: 'bad_name' });
        const r = await docker(['start', name]);
        return send(200, { ok: r.code === 0, out: r.out });
      }
      case 'status': {
        const name = String(body.name || url.searchParams.get('name') || '');
        if (!SAFE_NAME.test(name)) return send(400, { ok: false, error: 'bad_name' });
        const r = await docker(['inspect', '-f', '{{.State.Status}}', name]);
        return send(200, { ok: true, status: r.out.trim() });
      }
      case 'destroy': {
        const name = String(body.name || '');
        if (!SAFE_NAME.test(name)) return send(400, { ok: false, error: 'bad_name' });
        const r = await docker(['rm', '-f', name]);
        return send(200, { ok: r.code === 0, out: r.out });
      }
      // ─── Domínio próprio (plano Pro): snippet Caddy do domínio custom ─────
      // O agent MONTA o snippet a partir de campos re-validados por regex —
      // nunca aceita snippet pronto nem interpola nada em shell. O Caddy emite
      // o certificado TLS automaticamente ao ver o novo site block.
      case 'domain-apply': {
        const domain = String(body.domain || '').toLowerCase();
        const port = parseInt(body.host_port, 10);
        const caddyFile = String(body.caddy_file || '');
        if (!SAFE_DOMAIN.test(domain) || domain === 'maestrus.cloud' || domain.endsWith('.maestrus.cloud')
          || domain === 'maestrus.io' || domain.endsWith('.maestrus.io')) {
          return send(400, { ok: false, error: 'bad_domain' });
        }
        if (!(port >= 1024 && port <= 65535)) return send(400, { ok: false, error: 'bad_port' });
        if (!SAFE_CUSTOM_FILE.test(caddyFile)) return send(400, { ok: false, error: 'bad_file' });
        // Mesmo formato do snippet do subdomínio (container_run_spec no PHP).
        const snippet = `${domain} {\n    reverse_proxy 127.0.0.1:${port}\n    header Access-Control-Allow-Origin "*"\n}\n`;
        fs.mkdirSync(CADDY_TENANTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(CADDY_TENANTS_DIR, caddyFile), snippet);
        const reloaded = await caddyReload();
        return send(200, { ok: true, caddy_reloaded: reloaded });
      }
      case 'domain-remove': {
        const caddyFile = String(body.caddy_file || '');
        if (!SAFE_CUSTOM_FILE.test(caddyFile)) return send(400, { ok: false, error: 'bad_file' });
        try { fs.unlinkSync(path.join(CADDY_TENANTS_DIR, caddyFile)); } catch {}
        const reloaded = await caddyReload();
        return send(200, { ok: true, caddy_reloaded: reloaded });
      }
      case 'health':
        return send(200, { ok: true, agent: true });
      default:
        return send(404, { ok: false, error: 'unknown_op' });
    }
  } catch (e) {
    return send(500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => console.log('[agent] listening on', PORT));
