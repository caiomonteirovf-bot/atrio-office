/**
 * Consulta CNPJ na Receita Federal via APIs públicas
 */

const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

export async function consultarCNPJ(cnpj) {
  const digits = cnpj.replace(/\D/g, '');
  if (digits.length !== 14) throw new Error('CNPJ deve ter 14 dígitos');

  // Cache
  if (CACHE.has(digits)) {
    const cached = CACHE.get(digits);
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  }

  // BrasilAPI (gratuita, sem autenticação)
  const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error('CNPJ não encontrado na Receita Federal');
    throw new Error(`Erro na consulta: ${res.status}`);
  }

  const raw = await res.json();

  const data = {
    cnpj: raw.cnpj,
    razao_social: raw.razao_social,
    nome_fantasia: raw.nome_fantasia || '—',
    situacao_cadastral: raw.descricao_situacao_cadastral,
    data_situacao: raw.data_situacao_cadastral,
    data_abertura: raw.data_inicio_atividade,
    natureza_juridica: raw.descricao_natureza_juridica,
    porte: raw.porte,
    capital_social: raw.capital_social,
    cnae_principal: {
      codigo: raw.cnae_fiscal,
      descricao: raw.cnae_fiscal_descricao,
    },
    cnaes_secundarios: (raw.cnaes_secundarios || []).map(c => ({
      codigo: c.codigo,
      descricao: c.descricao,
    })),
    endereco: {
      logradouro: raw.logradouro,
      numero: raw.numero,
      complemento: raw.complemento,
      bairro: raw.bairro,
      cidade: raw.municipio,
      uf: raw.uf,
      cep: raw.cep,
    },
    socios: (raw.qsa || []).map(s => ({
      nome: s.nome_socio,
      qualificacao: s.qualificacao_socio,
      data_entrada: s.data_entrada_sociedade,
    })),
    simples_nacional: {
      optante: raw.opcao_pelo_simples,
      data_opcao: raw.data_opcao_pelo_simples,
      data_exclusao: raw.data_exclusao_do_simples,
    },
    mei: {
      optante: raw.opcao_pelo_mei,
    },
    telefone: raw.ddd_telefone_1 || '',
    email: raw.email || '',
  };

  CACHE.set(digits, { data, timestamp: Date.now() });
  return data;
}
