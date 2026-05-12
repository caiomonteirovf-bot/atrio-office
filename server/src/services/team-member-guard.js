/**
 * Team Member Detection
 * ---------------------
 * Detecta se um número de telefone pertence a um colaborador da Átrio
 * (Gesthub /colaboradores). Se for, Luna trata como COMUNICAÇÃO INTERNA
 * e não como atendimento de cliente.
 *
 * Diferença de comportamento:
 *  - Cliente externo:  buffer → LLM → resposta → alertas → escalation
 *  - Colaborador:      log interno + tag "interno" no chat da equipe
 *                      Luna NÃO responde, NÃO cria task, NÃO agenda
 *                      first-touch nem escalation
 */
import * as gesthub from './gesthub.js';
import { query } from '../db/pool.js';

let _cache = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min

function normalizeDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function loadTeam() {
  const now = Date.now();
  if (_cache && (now - _cachedAt) < CACHE_TTL_MS) return _cache;
  try {
    const list = await gesthub.getColaboradores();
    _cache = (list || [])
      .filter(c => c && (c.telefone || c.phone))
      .map(c => ({
        nome: c.nome || c.name || '',
        phoneDigits: normalizeDigits(c.telefone || c.phone),
        areas: c.areas || c.area || [],
      }))
      .filter(c => c.phoneDigits.length >= 10);
    _cachedAt = now;
  } catch (e) {
    console.error('[team-guard] loadTeam falhou:', e.message);
    if (!_cache) _cache = [];
  }
  return _cache;
}

/**
 * Retorna o colaborador se o phone bater com algum da Átrio, senão null.
 * Compara pelos últimos 8 dígitos pra resistir a variações de DDI/DDD/LID.
 */
export async function detectTeamMember(phone) {
  if (!phone) return null;
  const digits = normalizeDigits(phone);
  if (digits.length < 8) return null;
  const tail = digits.slice(-8);
  const team = await loadTeam();
  return team.find(m => m.phoneDigits.slice(-8) === tail) || null;
}

export function invalidateTeamCache() {
  _cache = null;
  _cachedAt = 0;
}

// ============================================
// AGENT (agents.id) → TEAM_MEMBER (team_members.id) mapping
// ============================================
// FK tasks.assigned_to/delegated_by → team_members(id), NÃO agents(id).
// Código costumava passar UUID de agents direto e quebrar com FK violation.
// Esta função resolve agent UUID → team_member UUID (cacheado).
let _agentTmCache = null;
let _agentTmCachedAt = 0;
const AGENT_TM_TTL_MS = 10 * 60 * 1000; // 10min

async function _loadAgentTeamMemberMap() {
  const now = Date.now();
  if (_agentTmCache && (now - _agentTmCachedAt) < AGENT_TM_TTL_MS) return _agentTmCache;
  try {
    const { rows } = await query(
      `SELECT agent_id::text AS agent_id, id::text AS tm_id
         FROM team_members
        WHERE agent_id IS NOT NULL AND type = 'ai'`
    );
    _agentTmCache = new Map(rows.map(r => [r.agent_id, r.tm_id]));
    _agentTmCachedAt = now;
  } catch (e) {
    console.error('[team-guard] loadAgentTeamMemberMap falhou:', e.message);
    if (!_agentTmCache) _agentTmCache = new Map();
  }
  return _agentTmCache;
}

/**
 * Resolve UUID de agents → UUID de team_members.
 * Usado em INSERT INTO tasks (assigned_to, delegated_by) — FKs apontam pra team_members.
 *
 * @param {string} agentId - UUID em agents.id (ex: 'a0000001-0000-0000-0000-000000000003')
 * @returns {Promise<string|null>} UUID em team_members.id ou null se não houver mapeamento
 */
export async function getTeamMemberIdForAgent(agentId) {
  if (!agentId) return null;
  const map = await _loadAgentTeamMemberMap();
  return map.get(String(agentId)) || null;
}

export function invalidateAgentTeamMemberCache() {
  _agentTmCache = null;
  _agentTmCachedAt = 0;
}
