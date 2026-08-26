#!/usr/bin/env bash
# Retenção dos artefatos de release em /opt/maestrus/data/downloads.
#
# Por quê: o CI copia um instalador (~200 MB × 3 plataformas) a cada build e
# NUNCA limpava — chegou a 71 GB e encheu o disco do servidor (117 GB), o que
# derrubou a produção: sem espaço o PHP não grava uploads, o multipart chega
# vazio e endpoints como voice_stt passam a responder 'no_api_key'.
#
# Mantém as N versões mais recentes de cada plataforma (o auto-update só usa a
# mais nova, apontada pelo latest*.yml — que nunca é apagado porque está sempre
# entre as mais recentes). Instalado como cron diário no host.
#
# Uso: bash prune-downloads.sh [N]   (padrão N=3)
set -euo pipefail

DIR="/opt/maestrus/data/downloads"
KEEP="${1:-3}"
cd "$DIR" 2>/dev/null || { echo "sem $DIR — nada a fazer"; exit 0; }

# Instaladores + seus .blockmap. O `|| true` é necessário: sem arquivos de uma
# extensão o `ls` falha e, com pipefail, derrubaria o script inteiro.
for ext in exe dmg AppImage; do
  { ls -t ./*."$ext" 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | xargs -r rm -f || true
  { ls -t ./*."$ext".blockmap 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | xargs -r rm -f || true
done

# Patches ASAR (update rápido): uma pasta por versão, por plataforma.
# latest.json é o ponteiro — nunca remover.
for plat in asar/*/; do
  [ -d "$plat" ] || continue
  ( cd "$plat" && { ls -t 2>/dev/null || true; } | grep -v '^latest.json$' | tail -n +$((KEEP + 1)) | xargs -r rm -rf || true )
done

echo "[prune-downloads] mantidas $KEEP versões por plataforma — livre: $(df -h / | awk 'NR==2{print $4}')"
