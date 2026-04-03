import dotenv from 'dotenv';
dotenv.config();

const GESTHUB_URL = process.env.GESTHUB_API_URL || 'https://gesthub-xlvb.onrender.com';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

let cache = { data: null, timestamp: 0 };

async function request(path, options = {}) {
  const url = `${GESTHUB_URL}/api${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
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
