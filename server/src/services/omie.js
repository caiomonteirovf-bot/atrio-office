/**
 * Omie API Client — preparado para quando as credenciais estiverem disponíveis
 * Docs: https://developer.omie.com.br/
 */
import dotenv from 'dotenv';
dotenv.config();

const OMIE_APP_KEY = process.env.OMIE_APP_KEY;
const OMIE_APP_SECRET = process.env.OMIE_APP_SECRET;
const OMIE_URL = 'https://app.omie.com.br/api/v1';

function isConfigured() {
  return !!(OMIE_APP_KEY && OMIE_APP_SECRET);
}

async function call(endpoint, method, params = {}) {
  if (!isConfigured()) throw new Error('Omie não configurado (falta APP_KEY e APP_SECRET)');

  const res = await fetch(`${OMIE_URL}/${endpoint}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      call: method,
      app_key: OMIE_APP_KEY,
      app_secret: OMIE_APP_SECRET,
      param: [params],
    }),
  });

  if (!res.ok) throw new Error(`Omie API error: ${res.status}`);
  return res.json();
}

// Listar clientes
export async function listarClientes(pagina = 1) {
  return call('geral/clientes', 'ListarClientes', {
    pagina, registros_por_pagina: 50, apenas_importado_api: 'N',
  });
}

// Contas a receber
export async function listarContasReceber(pagina = 1) {
  return call('financas/contareceber', 'ListarContasReceber', {
    pagina, registros_por_pagina: 50,
  });
}

// Contas a pagar
export async function listarContasPagar(pagina = 1) {
  return call('financas/contapagar', 'ListarContasPagar', {
    pagina, registros_por_pagina: 50,
  });
}

// Notas fiscais de serviço
export async function listarNfse(pagina = 1) {
  return call('servicos/nfse', 'ListarNFSe', {
    nPagina: pagina, nRegPorPagina: 50,
  });
}

export { isConfigured };
