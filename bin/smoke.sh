#!/usr/bin/env bash
# /opt/atrio-office/bin/smoke.sh
# Smoke test do Atrio Office — verifica em <30s se todas as armadilhas conhecidas
# estão sendo evitadas. Rodar após cada deploy ou quando algo parecer estranho.
#
# Saida: linhas ✓ verdes ou ✗ vermelhas com hint do fix.
# Exit 0 se tudo OK, 1 se algum check falhar.

set -u
RED=$'\e[31m'; GREEN=$'\e[32m'; YEL=$'\e[33m'; DIM=$'\e[2m'; RST=$'\e[0m'
PASS=0; FAIL=0; WARN=0

ok()   { echo -e "${GREEN}✓${RST} $1"; PASS=$((PASS+1)); }
err()  { echo -e "${RED}✗${RST} $1${2:+ ${DIM}→ fix: $2${RST}}"; FAIL=$((FAIL+1)); }
warn() { echo -e "${YEL}⚠${RST} $1"; WARN=$((WARN+1)); }
hdr()  { echo -e "\n${DIM}── $1 ──${RST}"; }

# ─────────────────────────────────────────────────────────
hdr "Containers"

for c in atrio-office-server-1 atrio-office-db-1; do
  status=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
  if [[ "$status" == "running" ]]; then
    ok "$c running"
  else
    err "$c status=$status" "cd /opt/atrio-office && docker compose up -d"
  fi
done

# ─────────────────────────────────────────────────────────
hdr "Networks (FDW reach)"

NETS=$(docker inspect atrio-office-db-1 --format '{{range $n,$_ := .NetworkSettings.Networks}}{{$n}} {{end}}' 2>/dev/null)
for need in atrio-office_default atrio_default gesthub_default; do
  if echo "$NETS" | grep -qw "$need"; then
    ok "db on $need"
  else
    err "db FORA da rede $need" "docker network connect $need atrio-office-db-1"
  fi
done

# ─────────────────────────────────────────────────────────
hdr "FDWs respondem"

FDW_TESTS=(
  "datalake_gesthub.clients|gesthub_srv"
  "datalake_banking.uploads_extrato|banking_srv"
  "datalake_nfse.nfses|nfse_srv"
)
for test in "${FDW_TESTS[@]}"; do
  table="${test%|*}"; srv="${test#*|}"
  out=$(docker exec atrio-office-db-1 psql -U atrio -d atrio_office -tAc "SELECT 1 FROM $table LIMIT 1" 2>&1)
  if [[ "$out" == "1" ]] || [[ "$out" == "" ]]; then
    ok "FDW $srv ok"
  else
    err "FDW $srv: $(echo "$out" | head -1)" "verificar redes + credenciais user_mapping"
  fi
done

# ─────────────────────────────────────────────────────────
hdr "Endpoints críticos (HTTP 200)"

ENDPOINTS=(
  "http://localhost:3010/api/health|health"
  "http://localhost:3010/api/datalake/summary|datalake"
  "http://localhost:3010/api/datalake/ecossistema|ecossistema"
  "http://localhost:3010/api/growth/kpis|growth"
  "http://localhost:3010/api/atendimento/daily-summary|atendimento Hoje"
  "http://localhost:3010/api/whatsapp/status|whatsapp status"
  "http://localhost:3010/api/errors/groups|erros"
  "http://localhost:3010/api/alerts/config|alertas"
)
for e in "${ENDPOINTS[@]}"; do
  url="${e%|*}"; label="${e#*|}"
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url")
  if [[ "$code" == "200" ]]; then
    ok "$label → 200"
  else
    err "$label → $code" "ver logs: docker logs atrio-office-server-1 --tail 50"
  fi
done

# ─────────────────────────────────────────────────────────
hdr "Bundle frontend (cache busting)"

dist_sw_ver=$(grep -oE "atrio-office-v[0-9]+" /opt/atrio-office/client/dist/sw.js 2>/dev/null | head -1)
public_sw_ver=$(grep -oE "atrio-office-v[0-9]+" /opt/atrio-office/client/public/sw.js 2>/dev/null | head -1)
if [[ -n "$dist_sw_ver" ]] && [[ "$dist_sw_ver" == "$public_sw_ver" ]]; then
  ok "SW versioning consistente ($dist_sw_ver)"
elif [[ -z "$dist_sw_ver" ]]; then
  err "dist/sw.js sem CACHE_VERSION" "rodar npm run build no client"
else
  warn "dist=$dist_sw_ver vs public=$public_sw_ver — divergiu, build pendente?"
fi

# ─────────────────────────────────────────────────────────
hdr "WhatsApp / Kill-switch"

ws=$(curl -sS http://localhost:3010/api/whatsapp/status 2>/dev/null)
if echo "$ws" | grep -q '"connected":true'; then
  phone=$(echo "$ws" | grep -oE '"phone":"[^"]*"' | cut -d'"' -f4)
  ok "WhatsApp conectado (${phone:-?})"
elif echo "$ws" | grep -q '"hasQR":true'; then
  warn "WhatsApp aguardando QR scan"
else
  warn "WhatsApp desconectado (sem QR pendente)"
fi

if docker logs atrio-office-server-1 2>&1 | grep -q 'Kill-switch agente→cliente: ATIVO'; then
  ok "Kill-switch agente→cliente ATIVO"
else
  warn "Kill-switch boot log não encontrado (pode ser que server reiniciou há muito tempo)"
fi

internal_count=$(docker logs atrio-office-server-1 2>&1 | grep -oE '\[internal-phones\] [0-9]+ telefones' | tail -1 | grep -oE '[0-9]+')
if [[ -n "$internal_count" ]] && [[ "$internal_count" -ge 5 ]]; then
  ok "Internal phones cache: $internal_count entradas"
elif [[ -n "$internal_count" ]]; then
  warn "Internal phones cache só $internal_count entradas (esperado >= 5)"
else
  warn "Internal phones cache não inicializou ainda"
fi

# ─────────────────────────────────────────────────────────
hdr "Erros recorrentes nos logs (últimos 10min)"

stale_count=$(docker logs atrio-office-server-1 --since 10m 2>&1 | grep -c 'stale scan: operator does not exist')
if [[ "$stale_count" -eq 0 ]]; then
  ok "watchdog stale scan limpo"
else
  err "watchdog stale scan: $stale_count erros" "ver luna-watchdog.js — bug integer=text"
fi

webpush_err=$(docker logs atrio-office-server-1 --since 10m 2>&1 | grep -c "Cannot find package 'web-push'")
if [[ "$webpush_err" -eq 0 ]]; then
  ok "web-push instalado na imagem"
else
  err "ERR_MODULE_NOT_FOUND web-push" "cd /opt/atrio-office && docker compose build server"
fi

# ─────────────────────────────────────────────────────────
hdr "Storage de anexos"

ATTACH_DIR=/opt/atrio-office/server/whatsapp-attachments
if [[ -d "$ATTACH_DIR" ]]; then
  acount=$(find "$ATTACH_DIR" -type f 2>/dev/null | wc -l)
  ok "diretorio existe ($acount arquivos)"
else
  err "$ATTACH_DIR nao existe" "docker cp atrio-office-server-1:/app/storage/whatsapp-attachments $ATTACH_DIR"
fi

mount_line=$(docker inspect atrio-office-server-1 --format '{{range .Mounts}}{{if eq .Destination "/app/storage/whatsapp-attachments"}}bind:{{.Source}}{{end}}{{end}}' 2>/dev/null)
if [[ -n "$mount_line" ]]; then
  ok "bind-mount ativo"
else
  err "SEM bind-mount em /app/storage/whatsapp-attachments" "compose.yml: adicionar ./server/whatsapp-attachments:/app/storage/whatsapp-attachments"
fi

LATEST_BACKUP=/opt/backups/whatsapp-attachments/latest
if [[ -L "$LATEST_BACKUP" ]] || [[ -d "$LATEST_BACKUP" ]]; then
  age_hours=$(( ( $(date +%s) - $(stat -c %Y "$LATEST_BACKUP") ) / 3600 ))
  if [[ $age_hours -le 30 ]]; then
    ok "backup recente (${age_hours}h atras)"
  else
    warn "backup tem ${age_hours}h (esperado <=30h)"
  fi
else
  err "sem backup ativo" "/opt/atrio-office/bin/backup_attachments.sh"
fi

db_ref=$(docker exec atrio-office-db-1 psql -U atrio -d atrio_office -tAc "SELECT count(*) FROM whatsapp_messages WHERE metadata->'attachment'->>'storage_path' IS NOT NULL" 2>/dev/null)
disk_count=$(find "$ATTACH_DIR" -type f 2>/dev/null | wc -l)
if [[ "$db_ref" -gt 0 ]] && [[ "$disk_count" -gt 0 ]]; then
  loss_pct=$(( (db_ref - disk_count) * 100 / db_ref ))
  if [[ $loss_pct -le 5 ]]; then
    ok "DB ref=$db_ref vs disco=$disk_count (perda ${loss_pct}%)"
  elif [[ $loss_pct -le 30 ]]; then
    warn "DB ref=$db_ref vs disco=$disk_count (perda ${loss_pct}%)"
  else
    err "PERDA ALTA: DB ref=$db_ref vs disco=$disk_count (${loss_pct}%)" "auditar com /tmp/audit_attachments.sh"
  fi
fi

# ─────────────────────────────────────────────────────────
echo
total=$((PASS+FAIL+WARN))
if [[ $FAIL -eq 0 ]] && [[ $WARN -eq 0 ]]; then
  echo -e "${GREEN}━━━ TODOS OS $total CHECKS PASSARAM ━━━${RST}"
  exit 0
elif [[ $FAIL -eq 0 ]]; then
  echo -e "${YEL}━━━ $PASS ok, $WARN warnings (sem falha crítica) ━━━${RST}"
  exit 0
else
  echo -e "${RED}━━━ $FAIL FALHAS · $WARN warnings · $PASS ok ━━━${RST}"
  exit 1
fi
