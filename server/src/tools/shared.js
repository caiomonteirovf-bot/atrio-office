import * as gesthub from '../services/gesthub.js';

/**
 * Consulta CNPJ na base do Gesthub — compartilhado entre Campelo e Sofia
 */
export async function consultarCnpj({ cnpj }) {
  if (!cnpj) return { erro: 'Parâmetro obrigatório: cnpj' };

  const cliente = await gesthub.searchClientByCnpj(cnpj);
  if (!cliente) {
    return {
      encontrado: false,
      mensagem: `CNPJ ${cnpj} não encontrado na base do escritório.`,
    };
  }

  return {
    encontrado: true,
    cliente: {
      id: cliente.id,
      razao_social: cliente.legalName,
      nome_fantasia: cliente.tradeName || '—',
      cnpj: cliente.document,
      regime: cliente.taxRegime,
      tipo: cliente.type,
      status: cliente.status,
      cidade: cliente.city,
      uf: cliente.state,
      responsavel: cliente.analyst || cliente.officeOwner,
      honorario: cliente.monthlyFee,
      fator_r: cliente.fatorR,
      inicio: cliente.startDate || '—',
    },
  };
}
