import * as gesthub from '../services/gesthub.js';
import { consultarCNPJ } from '../services/receita.js';

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
