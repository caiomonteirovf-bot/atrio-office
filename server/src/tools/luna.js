import { query } from '../db/pool.js';
import * as gesthub from '../services/gesthub.js';
import { consultarCliente } from './shared.js';
import { searchMemories, searchMemoriesHybrid } from '../services/embeddings.js';
import { getContext } from '../services/luna-observer.js';

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

  // 3.5d + 3.5f — busca hibrida (RRF de vector + full-text) por padrao
  async buscar_memorias({ query: q, limit = 5, source_type, tool_origin, entity_type, categoria, apenas_cliente_atual = true, modo = 'hibrido' }) {
    if (!q || String(q).trim().length < 2) {
      return { erro: 'query obrigatoria (minimo 2 chars)' };
    }
    const ctx = getContext() || {};
    const filter = {
      limit: Math.min(Number(limit) || 5, 20),
    };
    if (apenas_cliente_atual && ctx.clientId) filter.client_id = ctx.clientId;
    if (source_type) filter.source_type = String(source_type);
    if (tool_origin) filter.tool_origin = String(tool_origin);
    if (entity_type) filter.entity_type = String(entity_type);
    if (categoria) filter.category = String(categoria);

    const fn = modo === 'vetorial' ? searchMemories : searchMemoriesHybrid;
    try {
      const hits = await fn(String(q), filter);
      return {
        modo,
        encontradas: hits.length,
        memorias: hits.map(h => ({
          titulo: h.title,
          resumo: h.summary,
          conteudo: (h.content || '').slice(0, 400),
          categoria: h.category,
          similaridade: h.similarity != null ? Math.round(h.similarity * 100) / 100 : null,
          rrf_score: h.rrf_score != null ? Math.round(h.rrf_score * 10000) / 10000 : null,
          fontes: h.sources || (h.similarity != null ? ['vector'] : ['text']),
          vector_rank: h.vector_rank ?? null,
          text_rank: h.text_rank != null && typeof h.text_rank === 'number' && h.text_rank <= 50 ? h.text_rank : null,
          metadata: h.metadata || {},
          structured_facts: h.structured_facts || {},
        })),
      };
    } catch (e) {
      return { erro: String(e.message || e).slice(0, 300) };
    }
  },

  // 3.5e — consulta exata em structured_facts (JSONB). Ex: buscar pelo CNPJ de um tomador.
  async consultar_fatos_estruturados({ path, valor, cliente_atual_apenas = true, limit = 10 }) {
    if (!path || typeof path !== 'string') {
      return { erro: 'path obrigatorio. Ex: "tomador.cnpj", "nfse.numero"' };
    }
    // Converte 'tomador.cnpj' em operador JSONB #>> '{tomador,cnpj}'
    const parts = path.split('.').map(p => p.replace(/[^a-zA-Z0-9_]/g, ''));
    if (parts.length === 0 || parts.some(p => !p)) {
      return { erro: 'path invalido. Use letras/digitos/underscore separados por ponto.' };
    }
    const pgPath = '{' + parts.join(',') + '}';

    const ctx = getContext() || {};
    const params = [pgPath];
    const where = ["structured_facts #>> $1 IS NOT NULL", "status = 'approved'::memory_status"];
    let idx = 1;

    if (valor != null && valor !== '') {
      idx += 1;
      where.push(`structured_facts #>> $1 = $${idx}`);
      params.push(String(valor));
    }
    if (cliente_atual_apenas && ctx.clientId) {
      idx += 1;
      where.push(`scope_id = $${idx}::uuid AND scope_type = 'client'::memory_scope`);
      params.push(ctx.clientId);
    }

    const lim = Math.min(Number(limit) || 10, 50);
    idx += 1;
    params.push(lim);

    try {
      const { rows } = await query(
        `SELECT id, title, summary, category,
                structured_facts, metadata, created_at,
                structured_facts #>> $1 AS valor_encontrado
         FROM memories
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
        params
      );
      return {
        encontradas: rows.length,
        resultados: rows.map(r => ({
          titulo: r.title,
          resumo: r.summary,
          categoria: r.category,
          valor_no_path: r.valor_encontrado,
          structured_facts: r.structured_facts,
          criada_em: r.created_at,
        })),
      };
    } catch (e) {
      return { erro: String(e.message || e).slice(0, 300) };
    }
  },
};
