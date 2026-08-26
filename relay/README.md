# Maestrus Relay

Ponte WebSocket que liga **client ↔ host** do Maestrus remoto por conta, sob NAT.
Node puro + `ws`. Não persiste conteúdo — só roteia e mantém presença.

## Testar local
```bash
cd relay && npm install
npm test            # relay E2E (inclui isolamento entre contas)
node test/link.test.js   # RelayLink (RPC + streaming + reconexão)
```

## Provisionamento (já feito — referência)
O relay roda como container Docker dentro da stack `maestrus` em
`/opt/maestrus/` no servidor maestrus.cloud. O Caddy do host expõe em
`wss://maestrus.cloud/relay`.

1. Gerar um segredo forte (o MESMO entra no `.env` da stack e no
   `settings.relay_secret` do backend PHP):
   ```bash
   openssl rand -hex 32
   ```
2. Adicionar ao `/opt/maestrus/.env`: `RELAY_SECRET=<segredo>` (já consumido pelo
   `docker-compose.yml` do maestrus-cloud).
3. No admin/DB, salvar o MESMO segredo em `settings.relay_secret`.

> `deploy/maestrus-relay.service` e `deploy/nginx-relay.conf` são artefatos
> **legados** do deploy systemd anterior (host aitizer). Mantidos como
> referência caso alguém queira rodar o relay fora do Docker.

## Deploy contínuo
Push em `relay/**` dispara `.github/workflows/deploy-relay.yml`:
rsync `relay/` → `/opt/maestrus/relay/` no maestrus.cloud, depois
`docker compose build relay && docker compose up -d relay`.

## Tokens
HS256 (`relay/protocol.js`), payload `{ uid, did, role, exp }`. O backend PHP
emite por licença (`action=relay_token`); o relay só verifica a assinatura com
`RELAY_SECRET`. Cross-account é impossível: o relay só entrega frames a membros
da mesma `uid`.
