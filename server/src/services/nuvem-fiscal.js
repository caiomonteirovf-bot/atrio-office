/**
 * Nuvem Fiscal API Client — Emissão de NFS-e
 *
 * Autenticação: OAuth2 client_credentials
 * Sandbox: https://api.sandbox.nuvemfiscal.com.br
 * Produção: https://api.nuvemfiscal.com.br
 * Auth: https://auth.nuvemfiscal.com.br/oauth/token
 *
 * Fluxo: emitir DPS → consultar status → baixar PDF
 */
import dotenv from 'dotenv';
dotenv.config();

const CLIENT_ID = process.env.NUVEM_FISCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.NUVEM_FISCAL_CLIENT_SECRET;
const ENV = process.env.NUVEM_FISCAL_ENV || 'sandbox';

const AUTH_URL = 'https://auth.nuvemfiscal.com.br/oauth/token';
const API_URL = ENV === 'producao'
  ? 'https://api.nuvemfiscal.com.br'
  : 'https://api.sandbox.nuvemfiscal.com.br';

let tokenData = null; // { access_token, expires_at }

function log(msg) {
  console.log(`[NuvemFiscal] ${msg}`);
}

export function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// ============================================
// AUTENTICAÇÃO — OAuth2 client_credentials
// ============================================
async function getToken() {
  // Reutiliza token se ainda válido (margem de 60s)
  if (tokenData && Date.now() < tokenData.expires_at - 60000) {
    return tokenData.access_token;
  }

  log('Obtendo token OAuth2...');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'empresa nfse',
  });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Auth falhou (${res.status}): ${err}`);
  }

  const data = await res.json();
  tokenData = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in * 1000),
  };

  log(`Token obtido (expira em ${data.expires_in}s)`);
  return tokenData.access_token;
}

// ============================================
// HTTP HELPER
// ============================================
async function apiRequest(method, path, body = null, _retried = false) {
  const token = await getToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };

  if (body) opts.body = JSON.stringify(body);

  const url = `${API_URL}${path}`;
  const res = await fetch(url, opts);

  // 401 Unauthorized — invalidate token cache and retry once
  if (res.status === 401 && !_retried) {
    log(`Token expirado/inválido (401) em ${method} ${path} — renovando e retentando...`);
    tokenData = null;
    return apiRequest(method, path, body, true);
  }

  // PDF download retorna binary
  if (res.headers.get('content-type')?.includes('application/pdf')) {
    return { pdf: Buffer.from(await res.arrayBuffer()) };
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.message || JSON.stringify(data) || res.statusText;
    throw new Error(`API ${method} ${path} (${res.status}): ${errMsg}`);
  }

  return data;
}

// ============================================
// EMPRESA — Cadastro de prestador
// ============================================

/**
 * Cadastra ou atualiza empresa prestadora na Nuvem Fiscal.
 * Necessário antes de emitir NFS-e.
 */
export async function cadastrarEmpresa({ cnpj, razaoSocial, inscricaoMunicipal, email, endereco }) {
  if (!isConfigured()) throw new Error('Nuvem Fiscal não configurada');

  const payload = {
    cpf_cnpj: cnpj.replace(/\D/g, ''),
    nome_razao_social: razaoSocial,
    inscricao_municipal: inscricaoMunicipal || '',
    email: email || '',
  };

  if (endereco) {
    payload.endereco = {
      logradouro: endereco.logradouro,
      numero: endereco.numero,
      bairro: endereco.bairro,
      codigo_municipio: endereco.codigoMunicipio,
      cidade: endereco.cidade,
      uf: endereco.uf,
      cep: endereco.cep?.replace(/\D/g, ''),
    };
  }

  log(`Cadastrando empresa ${cnpj}...`);
  return apiRequest('PUT', `/empresas/${cnpj.replace(/\D/g, '')}`, payload);
}

/**
 * Configura NFS-e para a empresa (série, número, ambiente)
 */
export async function configurarNfse(cnpj, { serie = '1', numeroInicial = 1 } = {}) {
  if (!isConfigured()) throw new Error('Nuvem Fiscal não configurada');

  const cpfCnpj = cnpj.replace(/\D/g, '');
  const ambiente = ENV === 'producao' ? 1 : 2; // 1=produção, 2=homologação

  const payload = {
    rps: {
      lote: 1,
      serie: serie,
      numero: numeroInicial,
    },
    ambiente: ENV === 'producao' ? 'producao' : 'homologacao',
  };

  log(`Configurando NFS-e para ${cnpj} (ambiente: ${ENV})...`);
  return apiRequest('PUT', `/empresas/${cpfCnpj}/nfse`, payload);
}

// ============================================
// EMISSÃO DE NFS-e (DPS — Declaração de Prestação de Serviço)
// ============================================

/**
 * Emite uma NFS-e via Nuvem Fiscal.
 *
 * @param {Object} params
 * @param {string} params.prestadorCnpj — CNPJ de quem emite a nota
 * @param {string} params.tomadorCpfCnpj — CPF ou CNPJ de quem recebe
 * @param {string} params.tomadorNome — Nome/Razão Social do tomador
 * @param {number} params.valor — Valor do serviço
 * @param {string} params.descricao — Descrição do serviço
 * @param {string} [params.codigoServico] — Código tributação nacional (default: '0107')
 * @param {number} [params.aliquotaIss] — Alíquota ISS % (default: 5.0)
 * @param {string} [params.tomadorEndereco] — Endereço do tomador (opcional)
 * @param {string} [params.codigoMunicipio] — Código IBGE do município do prestador
 * @param {string} [params.referencia] — ID de referência interna
 *
 * @returns {{ id, status, numero, codigoVerificacao, dataEmissao }}
 */
export async function emitirNfse({
  prestadorCnpj,
  tomadorCpfCnpj,
  tomadorNome,
  valor,
  descricao,
  codigoServico = '0107',
  aliquotaIss = 5.0,
  codigoMunicipio,
  referencia,
}) {
  if (!isConfigured()) throw new Error('Nuvem Fiscal não configurada');

  const cnpjPrestador = prestadorCnpj.replace(/\D/g, '');
  const docTomador = tomadorCpfCnpj.replace(/\D/g, '');
  const isCnpj = docTomador.length === 14;
  const valorNum = typeof valor === 'string' ? parseFloat(valor.replace(/[^\d.,]/g, '').replace(',', '.')) : valor;
  const valorIss = valorNum * (aliquotaIss / 100);

  const agora = new Date();
  const dhEmi = agora.toISOString();
  const dCompet = agora.toISOString().split('T')[0];

  const payload = {
    ambiente: ENV === 'producao' ? 'producao' : 'homologacao',
    referencia: referencia || `atrio-fallback-${Date.now()}`,
    infDPS: {
      tpAmb: ENV === 'producao' ? 1 : 2,
      dhEmi,
      verAplic: 'AtrioOffice-1.0',
      dCompet,
      prest: {
        CNPJ: cnpjPrestador,
      },
      toma: {
        [isCnpj ? 'CNPJ' : 'CPF']: docTomador,
        xNome: tomadorNome,
      },
      serv: {
        cServ: {
          cTribNac: codigoServico,
          cTribMun: '501',
          CNAE: '6920601',
          xDescServ: descricao,
        },
      },
      valores: {
        vServPrest: {
          vServ: valorNum,
          vReceb: valorNum,
        },
        trib: {
          tribMun: {
            tribISSQN: 1, // 1 = Operação tributável
            vBC: valorNum,
            pAliq: aliquotaIss,
            vISSQN: valorIss,
            vLiq: valorNum - valorIss,
          },
          tribFed: {
            vRetCP: 0,
            vRetIRRF: 0,
            vRetCSLL: 0,
            piscofins: {
              CST: '06', // Operação tributável (base de cálculo = receita bruta)
              vBCPisCofins: 0,
              pAliqPis: 0,
              pAliqCofins: 0,
              vPis: 0,
              vCofins: 0,
            },
          },
        },
      },
    },
  };

  // Adiciona município se fornecido
  if (codigoMunicipio) {
    payload.infDPS.toma.end = {
      endNac: { cMun: codigoMunicipio },
    };
  }

  log(`Emitindo NFS-e: ${cnpjPrestador} → ${docTomador} (${tomadorNome}) R$ ${valorNum.toFixed(2)}`);
  const result = await apiRequest('POST', '/nfse/dps', payload);

  log(`NFS-e emitida: id=${result.id}, status=${result.status}`);
  return {
    id: result.id,
    status: result.status,
    numero: result.numero_nfse || result.numero,
    codigoVerificacao: result.codigo_verificacao,
    dataEmissao: result.data_emissao || dhEmi,
    raw: result,
  };
}

// ============================================
// CONSULTA
// ============================================

/**
 * Consulta o status de uma NFS-e pelo ID retornado na emissão.
 */
export async function consultarNfse(id) {
  if (!isConfigured()) throw new Error('Nuvem Fiscal não configurada');
  log(`Consultando NFS-e ${id}...`);
  return apiRequest('GET', `/nfse/dps/${id}`);
}

/**
 * Aguarda a NFS-e ser processada (polling com timeout).
 * Retorna quando status != 'processando' ou timeout.
 */
export async function aguardarProcessamento(id, timeoutMs = 30000, intervalMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await consultarNfse(id);
    if (result.status !== 'processando' && result.status !== 'pendente') {
      return result;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout aguardando NFS-e ${id} (${timeoutMs}ms)`);
}

// ============================================
// DOWNLOAD PDF
// ============================================

/**
 * Baixa o PDF da NFS-e emitida.
 * @returns {Buffer} PDF como Buffer
 */
export async function baixarPdf(id) {
  if (!isConfigured()) throw new Error('Nuvem Fiscal não configurada');
  log(`Baixando PDF da NFS-e ${id}...`);

  const token = await getToken();
  const url = `${API_URL}/nfse/dps/${id}/pdf`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/pdf',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PDF download falhou (${res.status}): ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  log(`PDF baixado: ${buffer.length} bytes`);
  return buffer;
}

// ============================================
// CANCELAMENTO
// ============================================

/**
 * Cancela uma NFS-e emitida.
 */
export async function cancelarNfse(id, motivo = 'Cancelamento solicitado') {
  if (!isConfigured()) throw new Error('Nuvem Fiscal não configurada');
  log(`Cancelando NFS-e ${id}...`);
  return apiRequest('POST', `/nfse/dps/${id}/cancelamento`, { justificativa: motivo });
}

// ============================================
// LISTAGEM
// ============================================

/**
 * Lista NFS-e emitidas por CNPJ do prestador.
 */
export async function listarNfse(cnpj, { top = 20, skip = 0 } = {}) {
  if (!isConfigured()) throw new Error('Nuvem Fiscal não configurada');
  const cpfCnpj = cnpj.replace(/\D/g, '');
  return apiRequest('GET', `/nfse/dps?cpf_cnpj=${cpfCnpj}&$top=${top}&$skip=${skip}`);
}
