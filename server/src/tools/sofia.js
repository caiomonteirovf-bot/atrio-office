import * as gesthub from '../services/gesthub.js';
import { consultarCnpj } from './shared.js';

export const tools = {
  consultar_cnpj: consultarCnpj,

  async checklist_abertura({ tipo_empresa, estado, atividade }) {
    if (!tipo_empresa) return { erro: 'Parâmetro obrigatório: tipo_empresa' };

    const uf = estado || 'PE';
    const checklists = {
      MEI: {
        requisitos: ['Faturamento até R$ 81.000/ano', 'Apenas 1 funcionário', 'Não ser sócio de outra empresa'],
        documentos: ['CPF e RG do titular', 'Comprovante de endereço', 'Título de eleitor ou declaração de IR'],
        etapas: [
          'Consultar atividades permitidas (CNAE MEI)',
          'Cadastro no Portal do Empreendedor (gov.br)',
          'Emissão automática do CCMEI',
          'Inscrição municipal (alvará)',
          'Cadastro na prefeitura para NFS-e',
        ],
        prazo_estimado: '1-3 dias úteis',
        custo_estimado: 'Gratuito (taxa DAS mensal a partir do mês seguinte)',
      },
      SLU: {
        requisitos: ['Sócio único (pessoa física)', 'Sem limite de faturamento', 'Capital social livre'],
        documentos: ['CPF e RG do titular', 'Comprovante de endereço pessoal e comercial', 'Certidão de casamento (se aplicável)', 'IPTU do endereço comercial'],
        etapas: [
          'Consulta de viabilidade de nome empresarial',
          `Registro na Junta Comercial (${uf === 'PE' ? 'JUCEPE' : 'Junta do ' + uf})`,
          'Obtenção do CNPJ na Receita Federal',
          'Inscrição Estadual (se comércio/indústria)',
          'Inscrição Municipal e Alvará',
          'Certificado Digital (e-CNPJ)',
          'Cadastro no sistema contábil',
        ],
        prazo_estimado: '7-15 dias úteis',
        custo_estimado: 'R$ 500 a R$ 1.500 (taxas + honorários)',
      },
      LTDA: {
        requisitos: ['Mínimo 2 sócios', 'Capital social definido em contrato', 'Responsabilidade limitada ao capital'],
        documentos: ['CPF e RG de todos os sócios', 'Comprovante de endereço de todos os sócios', 'Comprovante de endereço comercial', 'IPTU', 'Certidão de casamento dos sócios (se aplicável)'],
        etapas: [
          'Consulta de viabilidade de nome',
          'Elaboração do Contrato Social',
          'Assinatura do Contrato (certificado digital ou presencial)',
          `Registro na Junta Comercial (${uf === 'PE' ? 'JUCEPE' : 'Junta do ' + uf})`,
          'Obtenção do CNPJ',
          'Inscrição Estadual (se aplicável)',
          'Inscrição Municipal e Alvará',
          'Certificado Digital (e-CNPJ)',
          'Cadastro no sistema contábil',
        ],
        prazo_estimado: '10-20 dias úteis',
        custo_estimado: 'R$ 800 a R$ 2.500 (taxas + honorários)',
      },
      SS: {
        requisitos: ['Atividades intelectuais/profissionais', 'Sócios com habilitação profissional', 'Registro no conselho de classe'],
        documentos: ['CPF e RG dos sócios', 'Registro no conselho profissional', 'Comprovante de endereço', 'Comprovante de habilitação profissional'],
        etapas: [
          'Verificar registro no conselho de classe',
          'Elaboração do Contrato Social',
          'Registro no cartório (RCPJ) ou Junta Comercial',
          'Obtenção do CNPJ',
          'Inscrição Municipal',
          'Alvará de funcionamento',
          'Certificado Digital',
        ],
        prazo_estimado: '15-25 dias úteis',
        custo_estimado: 'R$ 1.000 a R$ 3.000',
      },
    };

    const checklist = checklists[tipo_empresa] || checklists.LTDA;

    return {
      tipo_empresa,
      estado: uf,
      atividade: atividade || 'Não especificada',
      ...checklist,
    };
  },

  async simular_estrutura({ num_socios, capital_social, atividade, faturamento_previsto }) {
    if (!num_socios || !atividade) {
      return { erro: 'Parâmetros obrigatórios: num_socios e atividade' };
    }

    const fat = faturamento_previsto || 0;
    const estruturas = [];

    if (fat <= 81000 && num_socios === 1) {
      estruturas.push({
        tipo: 'MEI',
        viavel: true,
        vantagens: ['Custo zero de abertura', 'DAS fixo mensal (~R$ 70)', 'Dispensa de contador'],
        desvantagens: ['Limite de R$ 81k/ano', 'Apenas 1 funcionário', 'CNAEs limitados'],
        custo_tributario_estimado: 'R$ 70-80/mês fixo',
      });
    }

    if (num_socios === 1) {
      estruturas.push({
        tipo: 'SLU (Sociedade Limitada Unipessoal)',
        viavel: true,
        vantagens: ['Sócio único', 'Sem limite de faturamento', 'Patrimônio pessoal protegido'],
        desvantagens: ['Custos de abertura maiores que MEI', 'Obrigações acessórias mensais'],
        custo_tributario_estimado: fat > 0 ? `${(fat * 0.06 / 12).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}/mês (Simples, estimativa)` : 'Depende do faturamento',
      });
    }

    if (num_socios >= 2) {
      estruturas.push({
        tipo: 'LTDA',
        viavel: true,
        vantagens: ['Flexibilidade na divisão de quotas', 'Responsabilidade limitada', 'Pode ter vários sócios'],
        desvantagens: ['Exige contrato social detalhado', 'Alterações contratuais custam'],
        custo_tributario_estimado: fat > 0 ? `Simples: ~${(fat * 0.06 / 12).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}/mês` : 'Depende do regime',
      });
    }

    const atividadeIntelectual = ['medic', 'advog', 'engenhei', 'psicol', 'odonto', 'contab', 'arquite'].some(p => atividade.toLowerCase().includes(p));
    if (atividadeIntelectual && num_socios >= 2) {
      estruturas.push({
        tipo: 'Sociedade Simples (SS)',
        viavel: true,
        vantagens: ['Adequada para profissionais liberais', 'ISS fixo em algumas cidades', 'Não sujeita a falência'],
        desvantagens: ['Apenas atividades intelectuais', 'Responsabilidade pode ser ilimitada'],
      });
    }

    if (fat > 500000 || (capital_social && capital_social > 100000)) {
      estruturas.push({
        tipo: 'Holding Patrimonial',
        viavel: true,
        vantagens: ['Proteção patrimonial', 'Planejamento sucessório', 'Otimização tributária sobre aluguéis'],
        desvantagens: ['Custo de manutenção', 'Complexidade operacional'],
        recomendacao: 'Indicada quando há patrimônio relevante para proteger.',
      });
    }

    return {
      perfil: { socios: num_socios, atividade, capital: capital_social, faturamento: fat },
      estruturas_possiveis: estruturas,
      recomendacao: estruturas[0]?.tipo || 'Consultar para análise detalhada',
    };
  },

  async gerar_contrato({ tipo_empresa, socios, capital_social, atividade }) {
    if (!tipo_empresa || !socios || !capital_social) {
      return { erro: 'Parâmetros obrigatórios: tipo_empresa, socios, capital_social' };
    }

    const sociosList = socios.split(',').map(s => s.trim());
    const quotasPorSocio = Math.floor(100 / sociosList.length);
    const fmt = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    return {
      tipo: tipo_empresa,
      modelo_contrato: {
        titulo: `CONTRATO SOCIAL DE ${tipo_empresa}`,
        clausulas: [
          {
            numero: 1,
            titulo: 'DA DENOMINAÇÃO SOCIAL',
            conteudo: `A sociedade girará sob a denominação social "[NOME EMPRESARIAL] ${tipo_empresa}", com sede em [ENDEREÇO COMPLETO].`,
          },
          {
            numero: 2,
            titulo: 'DO OBJETO SOCIAL',
            conteudo: `A sociedade tem por objeto social: ${atividade || '[DESCREVER ATIVIDADE]'}.`,
          },
          {
            numero: 3,
            titulo: 'DO CAPITAL SOCIAL',
            conteudo: `O capital social é de ${fmt(capital_social)}, dividido em ${capital_social} quotas de R$ 1,00 cada, distribuídas entre os sócios: ${sociosList.map((s, i) => `${s} — ${quotasPorSocio}% (${Math.floor(capital_social * quotasPorSocio / 100)} quotas)`).join('; ')}.`,
          },
          {
            numero: 4,
            titulo: 'DA ADMINISTRAÇÃO',
            conteudo: `A sociedade será administrada por ${sociosList[0]}, com poderes para representá-la ativa e passivamente, judicial e extrajudicialmente.`,
          },
          {
            numero: 5,
            titulo: 'DO PRÓ-LABORE',
            conteudo: 'Os sócios administradores farão jus a retirada mensal a título de pró-labore, em valor a ser definido em reunião de sócios.',
          },
          {
            numero: 6,
            titulo: 'DO EXERCÍCIO SOCIAL',
            conteudo: 'O exercício social encerrar-se-á em 31 de dezembro de cada ano.',
          },
        ],
        socios: sociosList.map((s, i) => ({
          nome: s,
          participacao: quotasPorSocio + '%',
          quotas: Math.floor(capital_social * quotasPorSocio / 100),
        })),
      },
      nota: 'Este é um MODELO simplificado. O contrato final deve ser revisado e adequado às normas da Junta Comercial do estado.',
    };
  },

  async alteracao_contratual({ tipo_alteracao, detalhes }) {
    if (!tipo_alteracao || !detalhes) {
      return { erro: 'Parâmetros obrigatórios: tipo_alteracao e detalhes' };
    }

    const modelos = {
      endereco: {
        titulo: 'ALTERAÇÃO DE ENDEREÇO',
        clausula: `Os sócios resolvem alterar o endereço da sede social para: ${detalhes}.`,
        documentos: ['Comprovante do novo endereço (IPTU ou contrato de locação)', 'Certificado digital para assinatura'],
      },
      atividade: {
        titulo: 'ALTERAÇÃO DE OBJETO SOCIAL',
        clausula: `Os sócios resolvem alterar o objeto social para: ${detalhes}.`,
        documentos: ['Consulta de viabilidade dos novos CNAEs', 'Certificado digital para assinatura'],
      },
      socios: {
        titulo: 'ALTERAÇÃO DO QUADRO SOCIETÁRIO',
        clausula: `Os sócios resolvem proceder à seguinte alteração no quadro societário: ${detalhes}.`,
        documentos: ['Documentos do novo sócio (RG, CPF, comprovante)', 'Distrato ou cessão de quotas', 'Certificado digital'],
      },
      capital: {
        titulo: 'ALTERAÇÃO DO CAPITAL SOCIAL',
        clausula: `Os sócios resolvem alterar o capital social conforme: ${detalhes}.`,
        documentos: ['Comprovante de integralização', 'Certificado digital para assinatura'],
      },
      nome: {
        titulo: 'ALTERAÇÃO DA DENOMINAÇÃO SOCIAL',
        clausula: `Os sócios resolvem alterar a denominação social para: ${detalhes}.`,
        documentos: ['Consulta de viabilidade do novo nome', 'Certificado digital para assinatura'],
      },
    };

    const modelo = modelos[tipo_alteracao] || {
      titulo: `ALTERAÇÃO: ${tipo_alteracao.toUpperCase()}`,
      clausula: detalhes,
      documentos: ['Certificado digital para assinatura'],
    };

    return {
      tipo: tipo_alteracao,
      modelo_alteracao: {
        ...modelo,
        etapas: [
          'Elaborar a alteração contratual',
          'Assinatura pelos sócios (certificado digital)',
          'Protocolar na Junta Comercial',
          'Aguardar deferimento',
          'Atualizar CNPJ na Receita Federal',
          'Atualizar Inscrição Municipal/Estadual',
        ],
      },
      prazo_estimado: '5-15 dias úteis',
    };
  },

  async consultar_jucep() {
    return {
      disponivel: false,
      mensagem: 'Integração com a JUCEPE (Junta Comercial de Pernambuco) em desenvolvimento. Em breve será possível consultar processos diretamente.',
    };
  },
};
