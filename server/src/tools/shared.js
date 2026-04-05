import * as gesthub from '../services/gesthub.js';
import { consultarCNPJ } from '../services/receita.js';

/**
 * Consulta cliente na base interna (Gesthub) por nome, CNPJ ou telefone.
 * Retorna dados completos: regime, honorário, Fator R, endereço, etc.
 */
export async function consultarCliente({ busca }) {
  if (!busca) return { erro: 'Parâmetro obrigatório: busca (nome, CNPJ ou telefone do cliente)' };

  const termo = busca.trim();
  const isNumeric = /^\d+$/.test(termo.replace(/\D/g, ''));
  const isCnpj = termo.replace(/\D/g, '').length >= 11;

  let resultados = [];

  if (isCnpj) {
    const cliente = await gesthub.searchClientByCnpj(termo);
    if (cliente) resultados = [cliente];
  }

  if (resultados.length === 0 && isNumeric) {
    const cliente = await gesthub.findClientByPhone(termo.replace(/\D/g, ''));
    if (cliente) resultados = [cliente];
  }

  if (resultados.length === 0) {
    resultados = await gesthub.searchClientByName(termo);
  }

  if (resultados.length === 0) {
    return {
      encontrado: false,
      mensagem: `Nenhum cliente encontrado para "${termo}" na base do Gesthub.`,
      sugestao: 'Tente buscar pelo CNPJ completo ou nome da razão social.',
    };
  }

  const fmt = (v) => v ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Não informado';

  return {
    encontrado: true,
    total: resultados.length,
    clientes: resultados.slice(0, 5).map(c => ({
      id: c.id,
      razao_social: c.legalName || '',
      nome_fantasia: c.tradeName || '',
      cnpj: c.document || '',
      regime_tributario: c.taxRegime || 'Não informado',
      status: c.status || '',
      honorario_mensal: fmt(c.monthlyFee),
      fator_r: c.fatorR || 'Não calculado',
      cnae: c.cnae || '',
      inscricao_municipal: c.municipalRegistration || '',
      cidade: c.city || '',
      uf: c.state || '',
      telefone: c.phone || '',
      email: c.email || '',
      responsavel: c.analyst || c.officeOwner || '',
    })),
  };
}

/**
 * Lista todos os clientes ativos do escritório (resumo).
 */
export async function listarClientes() {
  const clients = await gesthub.getClients();
  const ativos = clients.filter(c => c.status === 'ATIVO');

  const fmt = (v) => v ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—';

  return {
    total_ativos: ativos.length,
    total_geral: clients.length,
    clientes: ativos.slice(0, 30).map(c => ({
      razao_social: c.legalName?.substring(0, 50) || '',
      cnpj: c.document || '',
      regime: c.taxRegime || '—',
      honorario: fmt(c.monthlyFee),
      cidade: c.city || '—',
    })),
    nota: ativos.length > 30 ? `Mostrando 30 de ${ativos.length}. Use consultar_cliente para buscar específico.` : undefined,
  };
}

/**
 * Consulta CNPJ — primeiro na base interna (Gesthub), depois na Receita Federal
 */
export async function consultarCnpj({ cnpj }) {
  if (!cnpj) return { erro: 'Parâmetro obrigatório: cnpj' };

  // 1. Busca na base interna (Gesthub)
  const cliente = await gesthub.searchClientByCnpj(cnpj);

  // 2. Busca na Receita Federal (BrasilAPI)
  let receita = null;
  try {
    receita = await consultarCNPJ(cnpj);
  } catch (err) {
    console.log(`[Tools] Receita Federal: ${err.message}`);
  }

  if (!cliente && !receita) {
    return {
      encontrado: false,
      mensagem: `CNPJ ${cnpj} não encontrado na base interna nem na Receita Federal.`,
    };
  }

  return {
    encontrado: true,
    cliente_interno: cliente ? {
      id: cliente.id,
      razao_social: cliente.legalName,
      cnpj: cliente.document,
      regime: cliente.taxRegime,
      status: cliente.status,
      responsavel: cliente.analyst || cliente.officeOwner,
      honorario: cliente.monthlyFee,
      fator_r: cliente.fatorR,
    } : null,
    receita_federal: receita ? {
      razao_social: receita.razao_social,
      nome_fantasia: receita.nome_fantasia,
      situacao: receita.situacao_cadastral,
      data_abertura: receita.data_abertura,
      natureza_juridica: receita.natureza_juridica,
      capital_social: receita.capital_social,
      porte: receita.porte,
      cnae_principal: receita.cnae_principal,
      endereco: `${receita.endereco.logradouro}, ${receita.endereco.numero} - ${receita.endereco.cidade}/${receita.endereco.uf}`,
      socios: receita.socios,
      simples_nacional: receita.simples_nacional,
      mei: receita.mei,
      telefone: receita.telefone,
      email: receita.email,
    } : null,
    is_cliente: !!cliente,
  };
}
