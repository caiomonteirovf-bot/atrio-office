import dotenv from 'dotenv';
dotenv.config();

const GESTHUB_URL = process.env.GESTHUB_API_URL || 'https://gesthub-xlvb.onrender.com';
const GESTHUB_API_KEY = process.env.GESTHUB_API_KEY || '';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

let cache = { data: null, timestamp: 0 };

async function request(path, options = {}) {
  const url = `${GESTHUB_URL}/api${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const txt = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
    const suffix = res.status === 503 ? ' -- instancia suspensa no Render' : '';
    throw new Error(`Gesthub indisponivel (${res.status})${suffix} [${txt}]`);
  }
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `Gesthub error: ${res.status}`);
  }
  return payload.data;
}

// ============================================
// BOOTSTRAP (com cache)
// ============================================
export async function getBootstrap() {
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return cache.data;
  }
  console.log('[Gesthub] Buscando bootstrap...');
  const data = await request('/bootstrap');
  cache = { data, timestamp: now };
  return data;
}

export function invalidateCache() {
  cache = { data: null, timestamp: 0 };
}

// ============================================
// CLIENTS
// ============================================
export async function getClients() {
  const { clients } = await getBootstrap();
  return clients;
}

export async function searchClientByCnpj(cnpj) {
  const clients = await getClients();
  const normalized = cnpj.replace(/\D/g, '');
  return clients.find(c => c.document?.replace(/\D/g, '') === normalized) || null;
}

export async function searchClientByName(name) {
  const clients = await getClients();
  const term = name.toLowerCase();
  return clients.filter(c =>
    c.legalName?.toLowerCase().includes(term) ||
    c.tradeName?.toLowerCase().includes(term)
  ).slice(0, 10);
}

export async function getClient360(clientId) {
  return request(`/clients/${clientId}/360`);
}

export async function getClientObservacoes(clientId) {
  return request(`/clients/${clientId}/observacoes`);
}

// ============================================
// SALES
// ============================================
export async function getSales() {
  const { sales } = await getBootstrap();
  return sales;
}

export async function createSale(payload) {
  const data = await request('/sales', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  invalidateCache();
  return data;
}

// ============================================
// LEGALIZATIONS
// ============================================
export async function getLegalizations() {
  const { legalizations } = await getBootstrap();
  return legalizations;
}

export async function createLegalization(payload) {
  const data = await request('/legalizations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  invalidateCache();
  return data;
}

// ============================================
// COLABORADORES
// ============================================
export async function getColaboradores() {
  const { colaboradores } = await getBootstrap();
  return colaboradores;
}

// ============================================
// BUSCAR EMPRESA POR TELEFONE (cruza contatos)
// ============================================
// Canonicaliza telefone BR: remove DDI 55, insere 9 se faltar.
// Sempre retorna 11 dígitos (DD + 9 + 8 dígitos) para números BR válidos.
// Retorna string vazia se não for reconhecível.
function phoneKeyBR(raw) {
  let d = (raw || "").replace(/\D/g, "");
  if (!d) return "";
  // Remove DDI 55 se presente
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  // Se veio só 8 ou 9 dígitos (sem DDD), não dá pra normalizar com segurança
  if (d.length < 10) return d;
  // 10 dígitos: DD + 8dig (celular antigo sem 9) → insere 9
  if (d.length === 10) d = d.slice(0, 2) + "9" + d.slice(2);
  // 11 dígitos: DD + 9 + 8dig (formato canônico BR)
  if (d.length > 11) d = d.slice(-11);
  return d;
}

export async function findClientByPhone(phone) {
  const clients = await getClients();
  const key = phoneKeyBR(phone);
  if (!key) return null;

  for (const client of clients) {
    if (client.phone && phoneKeyBR(client.phone) === key) {
      return client;
    }
    if (Array.isArray(client.contatos)) {
      for (const contato of client.contatos) {
        if (contato.telefone && phoneKeyBR(contato.telefone) === key) {
          return { ...client, _contato: contato };
        }
      }
    }
  }
  return null;
}

// ============================================
// NPS
// ============================================
export async function getNpsDashboard(filters = {}) {
  const params = new URLSearchParams(filters).toString();
  return request(`/nps/dashboard${params ? `?${params}` : ''}`);
}

export async function createNPS(payload) {
  return request('/nps', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ============================================
// AUDIT
// ============================================
export async function getAuditLog(tabela, registroId) {
  const params = new URLSearchParams();
  if (tabela) params.set('tabela', tabela);
  if (registroId) params.set('registro_id', registroId);
  return request(`/auditoria?${params}`);
}

// ============================================
// ESCRITA — Sincronização bidirecional
// ============================================

function extHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (GESTHUB_API_KEY) headers['X-API-Key'] = GESTHUB_API_KEY;
  return headers;
}

function extBase() {
  return GESTHUB_API_KEY ? '/external' : '';
}

/**
 * Atualiza dados de um cliente no Gesthub (parcial — só campos presentes).
 * Aceita camelCase: { phone, email, logradouro, etc. }
 */
export async function updateClient(clientId, data) {
  invalidateCache();
  const prefix = extBase();
  const url = `${GESTHUB_URL}/api${prefix}/clients/${clientId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: extHeaders(),
    body: JSON.stringify(data),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `Erro ao atualizar cliente: ${res.status}`);
  }
  return payload.data;
}

/**
 * Dispara enriquecimento via Receita Federal no Gesthub.
 * O Gesthub busca na BrasilAPI e atualiza campos + importa sócios.
 */
export async function enrichClientCnpj(clientId) {
  invalidateCache();
  const prefix = extBase();
  const url = `${GESTHUB_URL}/api${prefix}/clients/${clientId}/enriquecer-cnpj`;
  const res = await fetch(url, {
    method: 'POST',
    headers: extHeaders(),
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `Erro ao enriquecer CNPJ: ${res.status}`);
  }
  return payload;
}
