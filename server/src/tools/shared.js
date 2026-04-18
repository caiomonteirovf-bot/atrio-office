import * as gesthub from '../services/gesthub.js';
import { consultarCNPJ } from '../services/receita.js';

// Deteccao heuristica de genero pelo primeiro nome — BR.
// Lista curada de finais e excecoes. Retorna 'M', 'F' ou null (indefinido).
const NOMES_F_EXCECOES = new Set([
  'nataly', 'natali', 'darci', 'daniele', 'michele', 'adriane', 'irene',
  'ingrid', 'isis', 'esther', 'beatriz', 'doris', 'iris', 'ines',
  'raquel', 'isabel', 'mabel', 'soledade', 'dayane', 'karen',
]);
const NOMES_M_EXCECOES = new Set([
  'jose', 'andre', 'dante', 'tome', 'jonas', 'moises', 'lucas', 'elias',
  'isaque', 'mateus', 'tobias', 'caique', 'heitor', 'nicolas', 'enzo',
]);
function detectarGenero(primeiroNome) {
  if (!primeiroNome) return null;
  const n = primeiroNome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!n) return null;
  if (NOMES_F_EXCECOES.has(n)) return 'F';
  if (NOMES_M_EXCECOES.has(n)) return 'M';
  // Heuristica: termina em 'a' quase sempre feminino no BR
  if (/(a)$/.test(n)) return 'F';
  // termina em 'e', 'i', 'o', 'u' ou consoante — masculino majoritario
  return 'M';
}
function pronomeTratamento(primeiroNome, genero) {
  const g = genero || detectarGenero(primeiroNome);
  if (!primeiroNome) return null;
  const nome = primeiroNome.trim().replace(/\b\w/g, l => l.toUpperCase());
  if (g === 'F') return `Drª ${nome}`;
  return `Dr. ${nome}`;
}



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
    clientes: await Promise.all(resultados.slice(0, 5).map(async (c) => {
      // Enriquece com contatos do Gesthub (o bootstrap nao traz por default)
      if (!Array.isArray(c.contacts) || !c.contacts.length) {
        try {
          const contatos = await gesthub.getClientContatos(c.id);
          c.contacts = contatos.map(ct => ({
            nome: ct.nome,
            cpf: ct.cpf,
            funcao: ct.funcao,
            telefone: ct.telefone,
            email: ct.email,
            genero: ct.genero,
          }));
        } catch {}
      }

      const tipo = (c.type || c.clientType || '').toUpperCase();
      const requerPronome = ['MEDICINA', 'ODONTO', 'ODONTOLOGIA'].includes(tipo);
      const contatos = Array.isArray(c.contacts) ? c.contacts : [];
      const socios = contatos.filter(ct => /SOCIO|PROPRIETARIO/i.test(String(ct.funcao || ct.role || '')));
      const contatosEnriquecidos = contatos.map(ct => {
        const primeiroNome = String(ct.nome || ct.name || '').trim().split(/\s+/)[0];
        const isSocio = /SOCIO|PROPRIETARIO/i.test(String(ct.funcao || ct.role || ''));
        const genero = ct.genero || detectarGenero(primeiroNome);
        return {
          nome: ct.nome || ct.name,
          cpf: ct.cpf || null,
          funcao: ct.funcao || ct.role || null,
          telefone: ct.telefone || ct.phone || null,
          email: ct.email || null,
          // Tratamento sugerido pela regra de negocio
          tratamento_sugerido: (requerPronome && isSocio && primeiroNome)
            ? pronomeTratamento(primeiroNome, genero)
            : primeiroNome || null,
          genero_detectado: genero,
        };
      });

      return {
        id: c.id,
        razao_social: c.legalName || '',
        nome_fantasia: c.tradeName || '',
        cnpj: c.document || '',
        tipo: tipo || null,
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
        // ⚠️ REGRA DE TRATAMENTO: empresa MEDICINA/ODONTO → socios sao Dr./Drª
        regra_tratamento: requerPronome
          ? `⚠️ Empresa ${tipo} — TODOS os socios devem ser chamados com Dr./Drª + primeiro nome. Veja 'contatos[].tratamento_sugerido'.`
          : null,
        contatos: contatosEnriquecidos,
        socios_para_chamar: requerPronome
          ? socios.map(s => {
              const pn = String(s.nome || s.name || '').trim().split(/\s+/)[0];
              return { nome_completo: s.nome || s.name, chamar_como: pronomeTratamento(pn, s.genero) };
            })
          : undefined,
      };
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
