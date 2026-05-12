#!/usr/bin/env bash
# /opt/atrio-office/bin/backup_attachments.sh
# Backup diario dos attachments do WhatsApp + retencao 14 dias.
# Rodar via cron: 0 3 * * * /opt/atrio-office/bin/backup_attachments.sh

set -euo pipefail

SOURCE=/opt/atrio-office/server/whatsapp-attachments
DEST_BASE=/opt/backups/whatsapp-attachments
RETENTION_DAYS=14
LOG=/var/log/atrio-attachments-backup.log

mkdir -p "$DEST_BASE"
TODAY=$(date +%Y-%m-%d)
DEST="$DEST_BASE/$TODAY"

if [[ ! -d "$SOURCE" ]]; then
  echo "[$(date -Iseconds)] ERRO: source $SOURCE nao existe" | tee -a "$LOG"
  exit 1
fi

# rsync com --link-dest pra economizar espaco (hard links pra arquivos inalterados)
LATEST="$DEST_BASE/latest"
mkdir -p "$DEST"
rsync -a --delete \
  ${LATEST:+--link-dest="$LATEST"} \
  "$SOURCE/" "$DEST/" 2>>"$LOG"

# Atualiza simlink 'latest'
rm -f "$LATEST"
ln -s "$DEST" "$LATEST"

# Limpa backups mais antigos que RETENTION_DAYS
find "$DEST_BASE" -maxdepth 1 -type d -name '????-??-??' -mtime +$RETENTION_DAYS -exec rm -rf {} \; 2>/dev/null || true

count=$(find "$DEST" -type f | wc -l)
size=$(du -sh "$DEST" | cut -f1)
echo "[$(date -Iseconds)] backup ok: $count arquivos, $size em $DEST" | tee -a "$LOG"
