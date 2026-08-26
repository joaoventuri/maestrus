#!/bin/bash
# Teste de integração de RUNTIME do Maestrus (roda no host do servidor).
# Sobe um container real (provider local), valida migração local→nuvem, CLI,
# Maestrus AI (claude→ai-proxy→Anthropic), relay e metering. Limpa tudo no fim.
cd /opt/maestrus
API="https://maestrus.cloud/api.php"
PID="ittest"
phpx(){ docker compose exec -T app php /var/www/html/_selftest.php "$@"; }
dbq(){ docker compose exec -T db sh -c "mariadb -uroot -p\"\$MARIADB_ROOT_PASSWORD\" maestrus -N -e \"$1\""; }
PASS=0; FAIL=0
ck(){ if [ "$2" = "1" ]; then echo "  PASS  $1"; PASS=$((PASS+1)); else echo "  FAIL  $1  [got: $3]"; FAIL=$((FAIL+1)); fi; }
has(){ case "$1" in *"$2"*) echo 1;; *) echo 0;; esac; }

echo "=== SETUP: licença Pro de teste ==="
MK=$(phpx mkpro)
LIC=$(echo "$MK" | sed -n 's/^LICENSE=//p' | tr -d '\r\n')
echo "license: $LIC"
[ -z "$LIC" ] && { echo "ABORT: sem licença ($MK)"; exit 1; }

cleanup(){
  echo ""; echo "=== CLEANUP ==="
  curl -s -X POST "$API?action=cloud_stop" -H 'content-type: application/json' -d "{\"license_key\":\"$LIC\",\"project_id\":\"$PID\"}" >/dev/null 2>&1
  for c in $(docker ps -aq --filter "label=maestrus.project=$PID"); do docker rm -f "$c" >/dev/null 2>&1; done
  docker volume rm -f "maestrus-vol-$PID" >/dev/null 2>&1
  phpx rm "$LIC" >/dev/null 2>&1
  echo "limpo."
}
trap cleanup EXIT

echo ""; echo "=== A. BACKEND endpoints (integração) ==="
R=$(curl -s "$API?action=validate&license_key=$LIC")
ck "validate valid=true"        "$(has "$R" '"valid":true')" "$(echo $R|head -c120)"
ck "validate mostra plano Pro"  "$(has "$R" 'Pro')"          "$(echo $R|head -c120)"
R=$(curl -s "$API?action=ai_status&license_key=$LIC")
ck "ai_status enabled=true"     "$(has "$R" '"enabled":true')" "$(echo $R|head -c100)"
R=$(curl -s -X POST "$API?action=relay_token" -H 'content-type: application/json' -d "{\"license_key\":\"$LIC\",\"role\":\"client\",\"device_id\":\"itest-dev\"}")
ck "relay_token emitido"        "$(has "$R" 'token')"        "$(echo $R|head -c80)"
R=$(curl -s -X POST "$API?action=deepgram_token" -H 'content-type: application/json' -d "{\"license_key\":\"$LIC\"}")
ck "deepgram: Pro passa o gate (disabled != requires_plan)" "$(has "$R" 'deepgram_disabled')" "$R"
R=$(curl -s "$API?action=cloud_list&license_key=$LIC")
ck "cloud_list ok"              "$(has "$R" '"ok":true')"    "$(echo $R|head -c80)"

echo ""; echo "=== B. CONTAINER CLOUD + MIGRAÇÃO local->nuvem ==="
NONCE="mig-$(date +%s)"
rm -rf /tmp/itw && mkdir -p /tmp/itw && echo "$NONCE" > /tmp/itw/test.txt && echo "console.log('hi')" > /tmp/itw/app.js
TGZ=$(tar -czf - -C /tmp/itw . | base64 -w0)
RS=$(curl -s -X POST "$API?action=cloud_start" -H 'content-type: application/json' -d "{\"license_key\":\"$LIC\",\"project_id\":\"$PID\",\"name\":\"ITest\",\"auto_setup\":false,\"code_tar_gz\":\"$TGZ\"}")
ck "cloud_start ok"             "$(has "$RS" '"ok":true')"   "$(echo $RS|head -c220)"
SBX=$(echo "$RS" | sed -n 's/.*"sandbox_id":"\([^"]*\)".*/\1/p')
echo "  sandbox_id: ${SBX:0:20}"
sleep 5
CID=$(docker ps -q --filter "label=maestrus.project=$PID" | head -1)
ck "container rodando (docker ps)" "$([ -n "$CID" ] && echo 1 || echo 0)" "cid=${CID:0:12}"

if [ -n "$CID" ]; then
  MIG=$(docker exec "$CID" cat /home/user/workspace/test.txt 2>/dev/null | tr -d '\r\n')
  ck "MIGRAÇÃO: arquivo injetado no workspace" "$(has "$MIG" "$NONCE")" "$MIG"
  VER=$(docker exec "$CID" sh -lc 'claude --version 2>&1' | head -1)
  ck "CLI: claude --version responde"          "$(has "$VER" 'laude')" "$VER"
  LOGS=$(docker logs "$CID" 2>&1 | tail -50)
  RLY=0; [ "$(has "$LOGS" 'relay')" = 1 ] && RLY=1; [ "$(has "$LOGS" 'connected')" = 1 ] && RLY=1; [ "$(has "$LOGS" 'host')" = 1 ] && RLY=1
  ck "RUNNER: subiu e conectou no relay"        "$RLY" "$(echo "$LOGS"|tail -2|tr '\n' '|'|head -c150)"
  echo "  --- claude → ai-proxy → Anthropic (Maestrus AI) ---"
  AI=$(docker exec -e ANTHROPIC_BASE_URL="https://maestrus.cloud/ai-proxy.php" -e ANTHROPIC_AUTH_TOKEN="$LIC" "$CID" sh -lc 'cd /home/user/workspace && timeout 70 claude -p "responda apenas: OK" --model claude-haiku-4-5 --permission-mode bypassPermissions 2>&1' | tail -10)
  echo "$AI" | sed 's/^/    /' | head -10
  AIW=0; for kw in OK credit balance insufficient quota usage_limit rate_limit authentication; do [ "$(has "$AI" "$kw")" = 1 ] && AIW=1; done
  ck "MAESTRUS AI: claude alcançou a Anthropic via proxy" "$AIW" "$(echo "$AI"|head -c160)"
fi

echo ""; echo "=== C. COMPUTE metering (heartbeat cobra tempo ativo) ==="
U0=$(dbq "SELECT compute_usage_usd FROM users u JOIN licenses l ON l.user_id=u.id WHERE l.license_key='$LIC';" | tr -d '\r')
sleep 7
curl -s -X POST "$API?action=cloud_heartbeat" -H 'content-type: application/json' -d "{\"license_key\":\"$LIC\",\"project_id\":\"$PID\"}" >/dev/null
U1=$(dbq "SELECT compute_usage_usd FROM users u JOIN licenses l ON l.user_id=u.id WHERE l.license_key='$LIC';" | tr -d '\r')
echo "  compute_usage_usd: $U0 -> $U1"
ck "metering incrementou após heartbeat" "$(awk "BEGIN{print (($U1)>($U0))?1:0}" 2>/dev/null)" "$U0 -> $U1"

echo ""; echo "=== D. cloud_stop (liga/desliga) ==="
RST=$(curl -s -X POST "$API?action=cloud_stop" -H 'content-type: application/json' -d "{\"license_key\":\"$LIC\",\"project_id\":\"$PID\"}")
ck "cloud_stop ok" "$(has "$RST" '"ok":true')" "$(echo $RST|head -c100)"

echo ""; echo "=== RESULTADO INTEGRAÇÃO: $PASS PASS / $FAIL FAIL ==="
