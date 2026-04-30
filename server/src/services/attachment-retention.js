/**
 * Retenção de anexos WhatsApp.
 *
 * Regra: arquivos com mtime > RETENTION_DAYS sao apagados do disco e marcados
 * como "expired" no metadata da mensagem. Texto da mensagem fica pra sempre
 * (historico do atendimento e valioso e texto e leve).
 *
 * Rodado diariamente via cron 'whatsapp_attach_retention' (ver index.js).
 */
import fs from 'fs/promises';
import path from 'path';
import { query } from '../db/pool.js';

const DEFAULT_RETENTION_DAYS = 30;
const STORAGE_BASE = process.env.WHATSAPP_ATTACH_DIR || '/app/storage/whatsapp-attachments';

/**
 * Walks recursivamente um diretorio, retorna array de { path, mtime, size }.
 */
async function walkDir(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...await walkDir(full));
    } else if (e.isFile()) {
      try {
        const stat = await fs.stat(full);
        out.push({ path: full, mtime: stat.mtime.getTime(), size: stat.size });
      } catch {}
    }
  }
  return out;
}

/**
 * Executa a varredura + limpeza.
 * Retorna { scanned, deleted, bytesLiberados, erros, retentionDays }.
 */
export async function cleanupExpiredAttachments({ dryRun = false } = {}) {
  const retentionDays = Number(process.env.WHATSAPP_ATTACH_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const files = await walkDir(STORAGE_BASE);
  const expired = files.filter(f => f.mtime < cutoffMs);

  let deleted = 0;
  let bytesLiberados = 0;
  const erros = [];

  for (const f of expired) {
    try {
      if (!dryRun) {
        // Marca msg como expired (mantem a referencia/metadata pra UI mostrar "expirou")
        await query(
          `UPDATE whatsapp_messages
           SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{attachment,expired}',
             'true'::jsonb
           )
           WHERE metadata->'attachment'->>'storage_path' = $1`,
          [f.path]
        ).catch(() => {});

        await fs.unlink(f.path);
      }
      deleted++;
      bytesLiberados += f.size;
    } catch (e) {
      erros.push({ path: f.path, error: e.message });
    }
  }

  // Tenta limpar diretorios vazios (cosmético)
  if (!dryRun) {
    try {
      const subdirs = await fs.readdir(STORAGE_BASE);
      for (const sub of subdirs) {
        const fullSub = path.join(STORAGE_BASE, sub);
        try {
          const stat = await fs.stat(fullSub);
          if (stat.isDirectory()) {
            const entries = await fs.readdir(fullSub);
            if (entries.length === 0) await fs.rmdir(fullSub).catch(() => {});
          }
        } catch {}
      }
    } catch {}
  }

  return {
    scanned: files.length,
    expired: expired.length,
    deleted,
    bytesLiberados,
    retentionDays,
    erros,
    dryRun,
  };
}

export function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
