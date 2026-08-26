#!/usr/bin/env bash
# Publica o web app + PWA pela via GIT (fim do rsync manual na produção).
#
# Fluxo: builda web/PWA aqui (repo claui) → copia pro repo backend
# (maestrus-cloud-backend) em app/web + app/app → commita + push. O deploy.yml
# do backend faz o rsync pra /opt/maestrus/app automaticamente. Git = prod.
#
# Uso:  bash scripts/publish-frontend.sh ["mensagem do commit"]
# Requer: gh autenticado (ou o repo já clonado em $BACKEND_DIR).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_REPO="joaoventuri/maestrus-cloud-backend"
BACKEND_DIR="${MAESTRUS_BACKEND_DIR:-/tmp/maestrus-cloud-backend}"
MSG="${1:-chore(web): rebuild web/PWA a partir do claui}"

cd "$ROOT"
echo "▸ Buildando web + PWA…"
npm run build:web
npm run build:mobile

echo "▸ Preparando o repo backend em $BACKEND_DIR…"
if [ -d "$BACKEND_DIR/.git" ]; then
  git -C "$BACKEND_DIR" pull --quiet
else
  rm -rf "$BACKEND_DIR"
  gh repo clone "$BACKEND_REPO" "$BACKEND_DIR" >/dev/null
fi

echo "▸ Copiando build → app/web e app/app (limpando assets velhos)…"
rsync -a --delete "$ROOT/dist-web/"    "$BACKEND_DIR/app/web/"
rsync -a --delete "$ROOT/dist-mobile/" "$BACKEND_DIR/app/app/"
# A prod serve index.html; nossos entries são web.html / mobile.html.
cp "$BACKEND_DIR/app/web/web.html"    "$BACKEND_DIR/app/web/index.html"
cp "$BACKEND_DIR/app/app/mobile.html" "$BACKEND_DIR/app/app/index.html"

cd "$BACKEND_DIR"
if git diff --quiet -- app/web app/app; then
  echo "✓ Nada mudou no web/PWA — nada a publicar."
  exit 0
fi
git add -A app/web app/app
git commit -q -m "$MSG

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin main
echo "✓ Publicado. O deploy.yml do backend deploya pra produção automaticamente."
