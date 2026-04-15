/**
 * Luna Tool Executor
 * Implementa as 6 tools definidas em public.agents.tools (Luna).
 * Contrato: executor(toolName, args) -> string|object (serializado e devolvido pro LLM).
 */
import { query } from '../db/pool.js';

async function rotear_para_rodrigo(args, ctx) {
  const tipo = String(args.tipo || '').toLowerCase();
  const descricao = String(args.descricao || '').slice(0, 2000);
  const prioridade = args.prioridade || 'media';
  if (!tipo || !descricao) return { ok: false, erro: 'tipo e descricao obrigatorios' };

  // GUARDA: rotear NFS-e exige intake confirmado
  if (tipo === 'fiscal_nfse' && ctx?.conversationId) {
    try {
      const { rows } = await query('SELECT nfse_intake FROM luna_v2.conversations WHERE id = $1', [ctx.conversationId]);
      const intake = rows[0]?.nfse_intake || {};
      if (!intake.confirmed) {
        const faltam = [];
        if (!intake.tomador_doc) faltam.push('tomador_doc (CNPJ/CPF)');
        if (!intake.descricao) faltam.push('descricao');
        if (!intake.valor) faltam.push('valor');
        if (!intake.confirmed) faltam.push('confirmacao_cliente');
        return {
          ok: false,
          erro: 'intake NFS-e incompleto',
          faltam,
          instrucao: 'Colete os campos pendentes via atualizar_nfse_intake, apresente confirmacao estruturada ao cliente, e so chame rotear_para_rodrigo apos ele dizer sim/ok/pode emitir (use confirmar_nfse_intake).',
        };
      }
    } catch (e) {
      console.error('[rotear guard] erro:', e.message);
    }
  }

  try {
    // assigned_to referencia team_members(id), nao agents(id)
    const { rows: rrows } = await query("SELECT id FROM public.team_members WHERE name = 'Rodrigo' LIMIT 1");
    const rodrigoId = rrows[0]?.id || null;
    const { rows } = await query(
      `INSERT INTO public.tasks (title, description, status, assigned_to, priority, result)
       VALUES ($1, $2, 'pending', $3, $4::task_priority, $5::jsonb) RETURNING id`,
      [
        `[${tipo}] ${descricao.slice(0, 80)}`,
        descricao,
        rodrigoId,
        ['alta','media','baixa'].includes(prioridade) ? (prioridade === 'alta' ? 'high' : prioridade === 'baixa' ? 'low' : 'medium') : 'medium',
        JSON.stringify({
          source: 'luna_rotear',
          tipo,
          conversation_id: ctx?.conversationId || null,
          client_id: ctx?.clientId || null,
          phone: ctx?.phone || null,
        }),
      ]
    );
    return { ok: true, task_id: rows[0].id, mensagem: `Demanda ${tipo} encaminhada ao Rodrigo (task ${rows[0].id.slice(0, 8)}).` };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

async function coletar_documento(args, ctx) {
  const cliente = String(args.cliente || '').slice(0, 200);
  const documento = String(args.documento || '').slice(0, 200);
  const status = args.status === 'recebido' ? 'recebido' : 'solicitado';
  if (!cliente || !documento) return { ok: false, erro: 'cliente e documento obrigatorios' };
  try {
    await query(
      `INSERT INTO luna_v2.memories
         (tipo, titulo, conteudo, agent_id, client_id, prioridade, confianca, status, is_rag_enabled, trigger_type, trigger_ref)
       VALUES ('documento', $1, $2, 'luna', $3, 4, 1.0, 'ativa', true, 'conversation', $4)`,
      [
        `Documento ${status}: ${documento}`,
        `Cliente ${cliente} — documento "${documento}" com status ${status}.`,
        ctx?.clientId || null,
        ctx?.conversationId || null,
      ]
    );
    return { ok: true, mensagem: `Documento ${documento} registrado como ${status} para ${cliente}.` };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

async function onboarding_cliente(args) {
  const nome = String(args.nome_cliente || 'Cliente').slice(0, 200);
  const cnpj = args.cnpj || 'a informar';
  return {
    ok: true,
    checklist: [
      '1. Contrato social (ultima alteracao)',
      '2. Cartao CNPJ (Receita Federal)',
      '3. Alvara de funcionamento',
      '4. Inscricao municipal e estadual (se houver)',
      '5. Dados bancarios (banco, agencia, conta)',
      '6. Procuracao digital (e-CAC)',
      '7. Login e senha do sistema emissor NFSe (se ja emite)',
    ],
    mensagem: `Checklist de onboarding preparado para ${nome} (${cnpj}). Informe ao cliente a lista acima e colete via coletar_documento.`,
  };
}

async function whatsapp_enviar() {
  // Canal ja e o proprio WhatsApp - a resposta da Luna e enviada automaticamente.
  return { ok: true, mensagem: 'Mensagem sera entregue ao cliente como resposta direta (canal WhatsApp).' };
}

async function whatsapp_receber() {
  return { ok: true, mensagem: 'Canal WhatsApp ja esta ativo, sem acao necessaria.' };
}

async function email_enviar(args) {
  const to = String(args.to || '').trim();
  const subject = String(args.subject || '').slice(0, 200);
  if (!to) return { ok: false, erro: 'destinatario (to) obrigatorio' };
  return { ok: true, mensagem: `Email para ${to} com assunto "${subject}" enfileirado (modulo de envio em implementacao).` };
}


async function registrar_memoria_cliente(args, ctx) {
  const tipo = String(args.tipo || 'preferencia').toLowerCase().trim();
  const titulo = String(args.titulo || '').slice(0, 200);
  const conteudo = String(args.conteudo || '').slice(0, 2000);
  const area = String(args.area || 'geral').toLowerCase().trim();
  const prioridade = Math.min(10, Math.max(1, Number(args.prioridade || 5)));
  if (!titulo || !conteudo) return { ok: false, erro: 'titulo e conteudo obrigatorios' };
  // Sem cliente identificado -> vai pra pending (sugestoes), nao entra no RAG
  const hasClient = !!ctx?.clientId;
  const status = hasClient ? 'ativa' : 'pending';
  const isRag = hasClient;
  try {
    const { rows } = await query(
      `INSERT INTO luna_v2.memories
         (tipo, titulo, conteudo, area, agent_id, client_id, prioridade, confianca,
          status, is_rag_enabled, trigger_type, trigger_ref)
       VALUES ($1, $2, $3, $9, 'luna', $4, $5, 1.0, $7, $8, 'conversation', $6)
       RETURNING id`,
      [tipo, titulo, conteudo, ctx?.clientId || null, prioridade, ctx?.conversationId || null, status, isRag, area]
    );
    return { ok: true, id: rows[0].id, status, mensagem: hasClient
      ? `Registrado ${tipo}: ${titulo}`
      : `Sugestao criada (aguarda aprovacao): ${titulo}` };
  } catch (e) { return { ok: false, erro: e.message }; }
}


// ============================================
// consultar_datalake — agentes enxergam o ecossistema
// Queries pre-definidas e parametrizadas (sem SQL livre)
// ============================================
async function consultar_datalake(args, ctx) {
  const tipo = String(args.tipo || '').toLowerCase();
  const filtro = String(args.filtro || '').trim();
  const limite = Math.min(50, Math.max(1, parseInt(args.limite) || 10));
  try {
    let sql, params;
    switch (tipo) {
      case 'cliente_por_cnpj': {
        const cnpjLimpo = filtro.replace(/\D/g, '');
        if (!cnpjLimpo) return { ok: false, erro: 'filtro CNPJ obrigatorio' };
        sql = `SELECT cnpj, razao_social, nome_fantasia, regime, status_gesthub,
                      mensalidade, socio_responsavel, analyst, city, state,
                      headcount, contas_bancarias, memorias_ativas, conversas_whatsapp
               FROM datalake.cliente_360
               WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1 LIMIT 1`;
        params = [cnpjLimpo];
        break;
      }
      case 'cliente_por_nome': {
        if (!filtro) return { ok: false, erro: 'filtro nome obrigatorio' };
        sql = `SELECT cnpj, razao_social, nome_fantasia, regime, status_gesthub,
                      mensalidade, socio_responsavel, analyst, city, state
               FROM datalake.cliente_360
               WHERE razao_social ILIKE '%'||$1||'%' OR nome_fantasia ILIKE '%'||$1||'%'
               ORDER BY mensalidade DESC LIMIT $2`;
        params = [filtro, limite];
        break;
      }
      case 'carteira_socio': {
        if (!filtro) return { ok: false, erro: 'filtro (nome do socio) obrigatorio' };
        sql = `SELECT razao_social, nome_fantasia, cnpj, regime, mensalidade, status_gesthub
               FROM datalake.cliente_360
               WHERE socio_responsavel ILIKE '%'||$1||'%'
               ORDER BY mensalidade DESC LIMIT $2`;
        params = [filtro, limite];
        break;
      }
      case 'resumo_carteira': {
        sql = `SELECT socio_responsavel,
                      count(*) AS total,
                      sum(mensalidade) AS receita_mensal,
                      count(*) FILTER (WHERE status_gesthub='ativo') AS ativos
               FROM datalake.cliente_360
               GROUP BY socio_responsavel
               ORDER BY receita_mensal DESC NULLS LAST`;
        params = [];
        break;
      }
      case 'clientes_sem_vinculo_luna': {
        sql = `SELECT cnpj, razao_social, socio_responsavel
               FROM datalake.cliente_360
               WHERE luna_client_id IS NULL AND status_gesthub='ativo'
               LIMIT $1`;
        params = [limite];
        break;
      }
      case 'contato_por_telefone': {
        const phoneDigits = filtro.replace(/\D/g, '');
        if (!phoneDigits) return { ok: false, erro: 'filtro (telefone) obrigatorio' };
        // Match ultimos 10-11 digitos (com/sem DDI)
        const tail = phoneDigits.slice(-8);
        sql = `SELECT ct.nome AS contato_nome, ct.funcao, ct.telefone, ct.email,
                      c.id AS cliente_id, c.document AS cnpj, c.legal_name AS razao_social,
                      c.trade_name AS nome_fantasia, c.status, c.tax_regime AS regime,
                      c.city, c.state, c.analyst, c.office_owner
               FROM datalake_gesthub.cliente_contatos ct
               JOIN datalake_gesthub.clients c ON c.id = ct.cliente_id
               WHERE regexp_replace(COALESCE(ct.telefone, ''), '\D', '', 'g') LIKE '%' || $1 || '%'
               ORDER BY c.status = 'ativo' DESC LIMIT 10`;
        params = [tail];
        break;
      }
      case 'total_clientes': {
        sql = `SELECT count(*) AS total,
                      count(*) FILTER (WHERE status_gesthub='ativo') AS ativos,
                      count(*) FILTER (WHERE luna_client_id IS NOT NULL) AS com_luna,
                      sum(mensalidade) AS receita_total
               FROM datalake.cliente_360`;
        params = [];
        break;
      }
      default:
        return { ok: false, erro: `tipo desconhecido. Use: cliente_por_cnpj, cliente_por_nome, contato_por_telefone, carteira_socio, resumo_carteira, clientes_sem_vinculo_luna, total_clientes` };
    }
    const r = await query(sql, params);
    return { ok: true, tipo, total: r.rowCount, dados: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

async function atualizar_nfse_intake(args, ctx) {
  if (!ctx?.conversationId) return { ok: false, erro: 'sem conversa ativa' };
  const campos_validos = ['tomador_doc', 'tomador_nome', 'tomador_razao_social', 'descricao', 'valor', 'codigo_servico', 'iss', 'observacoes'];
  const patch = {};
  for (const k of campos_validos) {
    if (args[k] !== undefined && args[k] !== null && args[k] !== '') patch[k] = String(args[k]).slice(0, 500);
  }
  if (Object.keys(patch).length === 0) return { ok: false, erro: 'nenhum campo valido informado', campos_validos };
  try {
    await query(
      `UPDATE luna_v2.conversations
       SET nfse_intake = COALESCE(nfse_intake, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [ctx.conversationId, JSON.stringify(patch)]
    );
    const { rows } = await query('SELECT nfse_intake FROM luna_v2.conversations WHERE id = $1', [ctx.conversationId]);
    return { ok: true, intake_atual: rows[0]?.nfse_intake || {}, atualizados: Object.keys(patch) };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function confirmar_nfse_intake(args, ctx) {
  if (!ctx?.conversationId) return { ok: false, erro: 'sem conversa ativa' };
  try {
    const { rows } = await query('SELECT nfse_intake FROM luna_v2.conversations WHERE id = $1', [ctx.conversationId]);
    const intake = rows[0]?.nfse_intake || {};
    const faltam = [];
    if (!intake.tomador_doc) faltam.push('tomador_doc');
    if (!intake.descricao) faltam.push('descricao');
    if (!intake.valor) faltam.push('valor');
    if (faltam.length) return { ok: false, erro: 'campos obrigatorios faltando', faltam };
    await query(
      `UPDATE luna_v2.conversations
       SET nfse_intake = COALESCE(nfse_intake, '{}'::jsonb) || jsonb_build_object('confirmed', true, 'confirmed_at', NOW()::text)
       WHERE id = $1`,
      [ctx.conversationId]
    );
    return { ok: true, mensagem: 'intake confirmado. Pode chamar rotear_para_rodrigo(tipo=fiscal_nfse).', intake };
  } catch (e) { return { ok: false, erro: e.message }; }
}

const REGISTRY = {
  consultar_datalake,
  registrar_memoria_cliente,
  rotear_para_rodrigo,
  coletar_documento,
  onboarding_cliente,
  email_enviar,
  atualizar_nfse_intake,
  confirmar_nfse_intake,
};

export function makeLunaExecutor(ctx) {
  return async (name, args) => {
    const fn = REGISTRY[name];
    if (!fn) return { ok: false, erro: `tool ${name} nao implementada` };
    try {
      const r = await fn(args || {}, ctx || {});
      console.log(`[luna-tools] ${name} ok=${r?.ok !== false}`);
      return r;
    } catch (e) {
      console.error(`[luna-tools] ${name} erro:`, e.message);
      return { ok: false, erro: e.message };
    }
  };
}

export default { makeLunaExecutor };
