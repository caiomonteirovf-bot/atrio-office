import { query } from '../db/pool.js';
import * as gesthub from '../services/gesthub.js';
import { consultarCliente } from './shared.js';

const AGENT_IDS = {
  rodrigo: 'a0000001-0000-0000-0000-000000000001',
};

const ONBOARDING_FASES = [
  {
    fase: 1, nome: 'Boas-vindas',
    items: ['Enviar mensagem de boas-vindas', 'Apresentar equipe responsável', 'Enviar kit do cliente'],
  },
  {
    fase: 2, nome: 'Documentos',
    items: ['Contrato social / Requerimento MEI', 'Documentos dos sócios (RG, CPF, comprovante)', 'Comprovante de endereço da empresa', 'Alvará / Licenças'],
  },
  {
    fase: 3, nome: 'Cadastros',
    items: ['Cadastrar no sistema contábil', 'Cadastrar no Omie (se aplicável)', 'Configurar certificado digital', 'Cadastrar procuração eletrônica (e-CAC)'],
  },
  {
    fase: 4, nome: 'Diagnóstico Fiscal',
    items: ['Verificar regime tributário', 'Calcular Fator R (se Simples)', 'Analisar CNAEs', 'Verificar obrigações acessórias pendentes'],
  },
  {
    fase: 5, nome: 'Reunião',
    items: ['Agendar reunião de alinhamento', 'Definir expectativas e SLA', 'Apresentar calendário de entregas', 'Definir canal de comunicação preferido'],
  },
  {
    fase: 6, nome: 'Ativação',
    items: ['Confirmar acesso a todos os sistemas', 'Primeira entrega (balancete/relatório)', 'Pesquisa NPS inicial', 'Marcar como ativo na carteira'],
  },
];

export const tools = {
  consultar_cliente: consultarCliente,

  async onboarding_cliente({ nome_cliente, cnpj }) {
    if (!nome_cliente) return { erro: 'Parâmetro obrigatório: nome_cliente' };

    let clienteGesthub = null;
    if (cnpj) {
      clienteGesthub = await gesthub.searchClientByCnpj(cnpj);
    }
    if (!clienteGesthub && nome_cliente) {
      const resultados = await gesthub.searchClientByName(nome_cliente);
      clienteGesthub = resultados[0] || null;
    }

    return {
      cliente: clienteGesthub ? {
        nome: clienteGesthub.legalName,
        cnpj: clienteGesthub.document,
        regime: clienteGesthub.taxRegime,
        status: clienteGesthub.status,
        ja_cadastrado: true,
      } : {
        nome: nome_cliente,
        cnpj: cnpj || 'Não informado',
        ja_cadastrado: false,
      },
      checklist: ONBOARDING_FASES.map(f => ({
        fase: f.fase,
        nome: f.nome,
        items: f.items.map(item => ({ descricao: item, concluido: false })),
      })),
      total_itens: ONBOARDING_FASES.reduce((sum, f) => sum + f.items.length, 0),
    };
  },

  async coletar_documento({ cliente, documento, status }) {
    if (!cliente || !documento) {
      return { erro: 'Parâmetros obrigatórios: cliente e documento' };
    }

    const statusDoc = status || 'solicitado';

    // Cria task para rastreamento
    const { rows: rodrigoRows } = await query(
      `SELECT tm.id FROM team_members tm WHERE tm.agent_id = $1`,
      [AGENT_IDS.rodrigo]
    );
    const { rows: lunaRows } = await query(
      `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Luna'`
    );

    const { rows } = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, completed_at, result)
       VALUES ($1, $2, $3, $4, 'medium', 'done', NOW(), $5) RETURNING id`,
      [
        `Documento: ${documento} — ${cliente}`,
        `Coleta de documento para ${cliente}: ${documento}. Status: ${statusDoc}`,
        lunaRows[0]?.id,
        rodrigoRows[0]?.id,
        JSON.stringify({ tipo: 'coleta_documento', cliente, documento, status: statusDoc }),
      ]
    );

    return {
      sucesso: true,
      registro: {
        task_id: rows[0].id,
        cliente,
        documento,
        status: statusDoc,
      },
      mensagem: statusDoc === 'recebido'
        ? `Documento "${documento}" de ${cliente} registrado como recebido.`
        : `Solicitação de "${documento}" registrada para ${cliente}. Aguardando envio.`,
    };
  },

  async rotear_para_rodrigo({ descricao, tipo, prioridade, cliente }) {
    if (!descricao || !tipo) {
      return { erro: 'Parâmetros obrigatórios: descricao e tipo' };
    }

    const { rows: rodrigoRows } = await query(
      `SELECT tm.id FROM team_members tm WHERE tm.agent_id = $1`,
      [AGENT_IDS.rodrigo]
    );
    const { rows: lunaRows } = await query(
      `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Luna'`
    );

    const { rows } = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, result)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        `[${tipo.toUpperCase()}] ${descricao.substring(0, 200)}`,
        `Demanda encaminhada por Luna.\nCliente: ${cliente || 'Não identificado'}\nTipo: ${tipo}\nDescrição: ${descricao}`,
        rodrigoRows[0]?.id,
        lunaRows[0]?.id,
        prioridade || 'medium',
        JSON.stringify({ origem: 'luna', tipo, cliente, roteamento: true }),
      ]
    );

    return {
      sucesso: true,
      encaminhada_para: 'Rodrigo (Diretor de Operações)',
      task_id: rows[0].id,
      classificacao: tipo,
      prioridade: prioridade || 'medium',
      mensagem: `Demanda classificada como "${tipo}" e encaminhada para Rodrigo com prioridade ${prioridade || 'medium'}.`,
    };
  },

  async whatsapp_enviar({ telefone, mensagem }) {
    if (!telefone || !mensagem) {
      return { erro: 'Parâmetros obrigatórios: telefone e mensagem' };
    }

    try {
      // Import dinâmico para evitar dependência circular
      const whatsapp = await import('../services/whatsapp.js');
      const status = whatsapp.getStatus();
      if (!status.connected) {
        return { disponivel: false, erro: 'WhatsApp não está conectado' };
      }

      // Limpa telefone e envia
      const phone = telefone.replace(/\D/g, '');
      await whatsapp.sendMessage(phone, mensagem);

      // Log da métrica
      await query(
        `INSERT INTO agent_metrics (agent_name, event_type, details) VALUES ($1, $2, $3)`,
        ['Luna', 'whatsapp_sent', JSON.stringify({ phone, messageLength: mensagem.length })]
      );

      return {
        sucesso: true,
        telefone: phone,
        mensagem_enviada: mensagem.substring(0, 100) + (mensagem.length > 100 ? '...' : ''),
      };
    } catch (err) {
      return { sucesso: false, erro: err.message };
    }
  },

  async whatsapp_receber() {
    return {
      disponivel: true,
      mensagem: 'Mensagens são recebidas automaticamente via whatsapp-web.js. Use o dashboard ou /api/whatsapp/pending para ver mensagens pendentes.',
    };
  },

  async email_enviar() {
    return {
      disponivel: false,
      mensagem: 'Integração de email em desenvolvimento.',
    };
  },
};
