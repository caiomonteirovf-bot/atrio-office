/**
 * Luna Memory - RAG + retroalimentacao + extracao de fatos (aprendizagem)
 */
import { query } from '../db/pool.js';
import { searchMemories } from './embeddings.js';

function stripCtx(t) {
  const i = String(t || '').indexOf('---FIM CONTEXTO---');
  return i >= 0 ? t.slice(i + '---FIM CONTEXTO---'.length).replace(/^\s+/, '') : t;
}

async function ensureConversation({ phone, clientId }) {
  const { rows } = await query(
    `SELECT id FROM luna_v2.conversations WHERE phone = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
    [phone]
  );
  if (rows[0]) return rows[0].id;
  const ins = await query(
    `INSERT INTO luna_v2.conversations (phone, client_id, status, stage, started_at, last_message_at)
     VALUES ($1, $2, 'ativa', 'recepcao', NOW(), NOW()) RETURNING id`,
    [phone, clientId || null]
  );
  return ins.rows[0].id;
}

async function fetchRecentMessages(conversationId, limit = 6) {
  const { rows } = await query(
    `SELECT direction, content, created_at FROM luna_v2.messages
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse();
}

async function fetchMemories({ clientId, conversationId, limit = 5 }) {
  // Prioridade: cliente identificado > memorias da propria conversa.
  // NUNCA retorna memorias orfas (client_id IS NULL E trigger_ref diferente) para evitar vazamento entre contatos.
  if (clientId) {
    const { rows } = await query(
      `SELECT titulo, conteudo, tipo, tags FROM luna_v2.memories
       WHERE client_id = $1 AND status = 'ativa'
       ORDER BY prioridade DESC NULLS LAST, confianca DESC NULLS LAST, last_used_at DESC NULLS LAST
       LIMIT $2`, [clientId, limit]);
    return rows;
  }
  if (conversationId) {
    const { rows } = await query(
      `SELECT titulo, conteudo, tipo, tags FROM luna_v2.memories
       WHERE trigger_ref = $1 AND status = 'ativa'
       ORDER BY prioridade DESC NULLS LAST, confianca DESC NULLS LAST, last_used_at DESC NULLS LAST
       LIMIT $2`, [conversationId, limit]);
    return rows;
  }
  // Sempre retorna global_rules (regras de comunicação que valem pra todos os clientes)
  try {
    const { rows } = await query(
      `SELECT titulo, conteudo, tipo, tags FROM luna_v2.memories
        WHERE trigger_type = 'global_rule' AND status = 'ativa' AND is_rag_enabled = true
        ORDER BY prioridade DESC NULLS LAST LIMIT $1`, [limit]);
    return rows;
  } catch { return []; }
}


// Busca memórias de public.memories escopadas: global + cliente atual + contato atual.
// Invocada em todo turno da Luna pra que regras manuais (via modal Ensinar) cheguem ao prompt.
async function fetchScopedMemories({ effectiveClientId, phone, limit = 15 }) {
  let contactUuid = null;
  if (phone) {
    const tail = String(phone).replace(/\D/g, '').slice(-8);
    if (tail) {
      try {
        const r = await query(
          `SELECT id FROM luna_v2.contacts
             WHERE regexp_replace(COALESCE(telefone,''),'\D','','g') LIKE '%' || $1 || '%'
             ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
          [tail]
        );
        contactUuid = r.rows[0]?.id || null;
      } catch {}
    }
  }
  try {
    const { rows } = await query(
      `SELECT id, scope_type::text AS scope_type, category::text AS category,
              title, content, summary, priority
         FROM public.memories
        WHERE status = 'approved' AND is_rag_enabled = true
          AND (
            scope_type = 'global'
            OR (scope_type = 'client'  AND scope_id = $1::uuid)
            OR (scope_type = 'contact' AND scope_id = $2::uuid)
          )
        ORDER BY priority DESC NULLS LAST, created_at DESC
        LIMIT $3`,
      [effectiveClientId, contactUuid, limit]
    );
    return { rows, contactUuid };
  } catch (e) {
    console.error('[fetchScopedMemories]', e.message);
    return { rows: [], contactUuid: null };
  }
}

async function fetchSoul() {
  // Carrega "alma" da Luna + roster dos outros agentes do DB. Unica fonte de verdade.
  try {
    const { rows } = await query(
      `SELECT name, role, department, system_prompt, personality, status
       FROM public.agents ORDER BY name = 'Luna' DESC, name ASC`
    );
    const luna = rows.find(r => r.name === 'Luna');
    const outros = rows.filter(r => r.name !== 'Luna');
    return { luna, outros };
  } catch (e) {
    console.error('[luna-memory] fetchSoul erro:', e.message);
    return { luna: null, outros: [] };
  }
}

export async function buildContext({ phone, clientInfo }) {
  const clientIdIn = clientInfo?.id || clientInfo?.client_id || null;
  const isUuid = typeof clientIdIn === 'string' && /^[0-9a-f-]{36}$/i.test(clientIdIn);
  let effectiveClientId = isUuid ? clientIdIn : null;
  let conversationId = await ensureConversation({ phone, clientId: effectiveClientId });

  // === Lookup automatico no datalake por telefone ===
  let datalakeHits = [];
  try {
    if (phone) {
      const tail = String(phone).replace(/\D/g, '').slice(-8);
      if (tail) {
        const r = await query(`
          SELECT ct.nome AS contato_nome, ct.funcao, ct.telefone,
                 c.id AS cliente_id, c.document AS cnpj, c.legal_name AS razao_social,
                 c.trade_name AS nome_fantasia, c.tax_regime AS regime,
                 c.city, c.state, c.analyst, c.office_owner AS socio_responsavel,
                 c.inscricao_municipal, c.codigo_servico, c.aliquota_iss,
                 c.status
          FROM datalake_gesthub.cliente_contatos ct
          JOIN datalake_gesthub.clients c ON c.id = ct.cliente_id
          WHERE regexp_replace(COALESCE(ct.telefone, ''), '\D', '', 'g') LIKE '%' || $1 || '%'
          ORDER BY c.status = 'ATIVO' DESC LIMIT 5
        `, [tail]);
        datalakeHits = r.rows || [];
      }
    }
  } catch (e) {
    console.error('[buildContext] datalake lookup:', e.message);
  }


  // Se contato identificado com 1 hit unico, upsert em luna_v2.clients e usa como client_id
  if (!effectiveClientId && datalakeHits.length === 1) {
    const h = datalakeHits[0];
    try {
      const up = await query(`
        INSERT INTO luna_v2.clients (gesthub_id, cnpj, nome_legal, nome_fantasia, regime_tributario)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (cnpj) DO UPDATE SET
          gesthub_id = EXCLUDED.gesthub_id,
          nome_legal = EXCLUDED.nome_legal,
          nome_fantasia = EXCLUDED.nome_fantasia,
          regime_tributario = EXCLUDED.regime_tributario,
          sync_gesthub_at = NOW()
        RETURNING id`,
        [h.cliente_id, h.cnpj, h.razao_social || h.nome_fantasia || 'Sem nome', h.nome_fantasia, h.regime]);
      if (up.rows[0]?.id) {
        effectiveClientId = up.rows[0].id;
        // re-garante conversation vinculada ao client
        await query(`UPDATE luna_v2.conversations SET client_id = $1 WHERE id = $2 AND client_id IS NULL`,
          [effectiveClientId, conversationId]);
      }
    } catch (e) {
      console.error('[buildContext] upsert luna client:', e.message);
    }
  }

  // Busca ultima mensagem inbound para usar como query na busca semantica
  const history = await fetchRecentMessages(conversationId, 6);
  const lastInbound = [...history].reverse().find(h => h.direction === 'inbound');
  const queryText = lastInbound ? String(lastInbound.content || '').slice(0, 500) : null;

  const [memories, soul, semanticHits, scoped] = await Promise.all([
    fetchMemories({ clientId: effectiveClientId, conversationId, limit: 5 }),
    fetchSoul(),
    queryText
      ? searchMemories(queryText, { limit: 5 }).then(arr => arr.filter(m => (m.similarity || 0) >= 0.6).slice(0, 3))
          .catch(err => { console.error('[buildContext] searchMemories:', err.message); return []; })
      : Promise.resolve([]),
    fetchScopedMemories({ effectiveClientId, phone, limit: 15 }),
  ]);

  const parts = [];

  // === SOUL.md — princípios permanentes (self-improving pattern) ===
  // Fica no TOP do contexto pra que NUNCA seja ignorado pelo LLM, mesmo em prompts longos.
  try {
    const fs = await import('node:fs/promises');
    const soulPath = '/app/agents/luna/SOUL.md';
    const soul = await fs.readFile(soulPath, 'utf-8').catch(() => null);
    if (soul) {
      parts.push('## ⚠️ PRINCÍPIOS NÃO-NEGOCIÁVEIS (SOUL)');
      // Pega só as seções Premissas + Operação (não o promotion log — evita bloat)
      const soulEssence = soul
        .split(/^## /m)
        .filter(sec => /Premissas|Operação|Fronteiras|Formato/i.test(sec))
        .map(sec => '## ' + sec.trim())
        .join('\n\n');
      parts.push(soulEssence);
      parts.push('');
    }
  } catch (e) { console.error('[buildContext] SOUL.md nao carregado:', e.message); }

  // === LEARNINGS PENDING — o que foi detectado errado recentemente ===
  // Injeta até 3 learnings com severity high/critical que ainda não foram resolvidos.
  // Luna vê os próprios erros recentes e NÃO repete.
  try {
    const { listPending } = await import('./learning-log.js');
    const errs = await listPending({ file: 'ERRORS.md', limit: 3 });
    const criticos = errs.filter(e => ['critical','high'].includes(e.priority));
    if (criticos.length > 0) {
      parts.push('## 🚨 Incidentes recentes a NÃO repetir');
      criticos.forEach((e, i) => parts.push(`${i + 1}. [${e.id}] ${e.summary}`));
      parts.push('');
    }
  } catch (e) { console.error('[buildContext] learnings pending falhou:', e.message); }

  // === ESTADO DA CONVERSA (reforco anti-repeticao) ===
  const turnos = history.length;
  const lunaJaFalou = history.some(h => h.direction === 'outbound');
  const ultimaLunaTxt = [...history].reverse().find(h => h.direction === 'outbound')?.content || '';
  const jaCumprimentou = /bom\s+dia|boa\s+tarde|boa\s+noite|ol[áa]|oi/i.test(ultimaLunaTxt);
  const jaDisseForaHora = /fora\s+do\s+hor[áa]rio|retorn(a|amos)|pr[óo]ximo\s+dia\s+[úu]til/i.test(ultimaLunaTxt);
  const jaPediuDetalhe = /me\s+(conta|diga|informe|passe)|precis(o|amos)\s+de/i.test(ultimaLunaTxt);

  if (turnos > 0) {
    parts.push('## Estado da conversa atual (leia antes de responder)');
    parts.push(`- Turnos ja trocados: ${turnos}`);
    parts.push(`- Voce ja cumprimentou o cliente nesta conversa: ${jaCumprimentou ? 'SIM — NAO cumprimente de novo' : 'nao'}`);
    parts.push(`- Voce ja avisou que estamos fora do horario: ${jaDisseForaHora ? 'SIM — NAO repita' : 'nao'}`);
    parts.push(`- Voce ja pediu pro cliente detalhar a demanda: ${jaPediuDetalhe ? 'SIM — agora avance o contexto, faca UMA pergunta nova baseada na resposta' : 'nao'}`);
    parts.push('**Regra:** cada resposta avanca UM passo. Nao reinicie. Nao reempacote. Nao pergunte tudo de uma vez.');
    parts.push('');
  }

  // Nao duplicamos system_prompt aqui: claude.js ja injeta via agent.system_prompt.
  // So mantemos o roster da equipe pra Luna saber a quem delegar.
  if (soul.outros?.length) {
    parts.push('\n## Equipe do Atrio (para delegacao)');
    soul.outros.forEach(a => {
      parts.push(`- ${a.name} (${a.role}, ${a.department}) — status: ${a.status}`);
    });
  }
  if (datalakeHits.length === 1) {
    const h = datalakeHits[0];
    parts.push(`## Contato identificado no cadastro`);
    parts.push(`- Nome: ${h.contato_nome} (${h.funcao || 'contato'})`);
    parts.push(`- Empresa: ${h.nome_fantasia || h.razao_social}`);
    parts.push(`- CNPJ: ${h.cnpj} | Regime: ${h.regime || '—'} | Status: ${h.status}`);
    if (h.analyst) parts.push(`- Analista interno: ${h.analyst}`);
    if (h.inscricao_municipal) parts.push(`- Insc. Municipal: ${h.inscricao_municipal} | Cod. serviço: ${h.codigo_servico || '—'} | ISS: ${h.aliquota_iss || '—'}%`);
    parts.push(`**Já sabe quem é. Cumprimente APENAS pelo primeiro nome. NÃO mencione a empresa na saudação — o cliente sabe onde trabalha. Essa info é só pro seu contexto, não repita pra ele.**`);
  } else if (datalakeHits.length > 1) {
    parts.push(`## Contato em multiplas empresas (${datalakeHits.length})`);
    datalakeHits.forEach(h => parts.push(`- ${h.nome_fantasia || h.razao_social} (${h.cnpj})`));
    parts.push(`**Pergunta em UMA frase sobre qual empresa o cliente fala hoje.**`);
  } else if (phone) {
    parts.push(`## Contato desconhecido`);
    parts.push(`- Telefone ${phone} nao aparece no cadastro Gesthub.`);
    parts.push(`**Trate como prospect: cordial, uma frase, pede nome+empresa.**`);
  }

  if (clientInfo) {
    parts.push(`## Cliente conhecido`);
    const nome = clientInfo.pushname || clientInfo.contact_name || clientInfo.nome_fantasia || clientInfo.razao_social || clientInfo.nome || '—';
    parts.push(`- Nome: ${nome}`);
    if (clientInfo.cnpj) parts.push(`- CNPJ: ${clientInfo.cnpj}`);
    if (clientInfo.regime) parts.push(`- Regime: ${clientInfo.regime}`);
    if (clientInfo.municipio) parts.push(`- Municipio: ${clientInfo.municipio}`);
    if (clientInfo.tipo) parts.push(`- Tipo: ${clientInfo.tipo} (regra Dr./Dra: so MEDICINA/ODONTO recebem titulo)`);
    if (clientInfo.contato?.funcao || clientInfo.contato?.nome) {
      parts.push(`- Contato ativo: ${clientInfo.contato.nome || '(sem nome)'}${clientInfo.contato.funcao ? ' (' + clientInfo.contato.funcao + ')' : ''}`);
    }
  }
  // Regras escopadas (global/client/contact) — ALTA prioridade no prompt
  if (scoped?.rows?.length) {
    parts.push(`
## Regras obrigatorias (aplicar SEMPRE)`);
    scoped.rows.forEach((m, i) => {
      const escopo = m.scope_type === 'global' ? 'GLOBAL'
                   : m.scope_type === 'client'  ? 'ESTE CLIENTE'
                   : m.scope_type === 'contact' ? 'ESTE CONTATO'
                   : 'agente';
      parts.push(`${i + 1}. [${escopo}/${m.category}] ${m.title} — ${m.content}`);
    });
  }
    if (memories.length) {
    parts.push(`\n## Memorias relevantes`);
    memories.forEach((m, i) => parts.push(`${i + 1}. [${m.tipo || 'fato'}] ${m.titulo || ''} — ${m.conteudo}`));
  }
  if (semanticHits && semanticHits.length) {
    parts.push(`\n## Conhecimento relacionado (busca semantica)`);
    semanticHits.forEach((m, i) => {
      const sim = Math.round((m.similarity || 0) * 100);
      const body = String(m.summary || m.content || m.conteudo || '').slice(0, 220);
      parts.push(`${i + 1}. [${m.category || m.tipo || 'memoria'}] ${m.title || m.titulo || ''} (rel. ${sim}%) — ${body}`);
    });
  }
  if (history.length) {
    parts.push(`\n## Ultimas mensagens`);
    history.forEach((h) => {
      const who = h.direction === 'inbound' ? 'Cliente' : 'Luna';
      parts.push(`${who}: ${String(h.content || '').slice(0, 240)}`);
    });
  }
  const block = parts.length ? `---CONTEXTO---\n${parts.join('\n')}\n---FIM CONTEXTO---\n\n` : '';
  return { block, conversationId, clientId: effectiveClientId };
}

export async function persistTurn({ conversationId, userContent, assistantContent, agentId = 'luna', llmLatencyMs = null, modelUsed = null, toolCalls = 0 }) {
  if (!conversationId) return;
  try {
    await query(
      `INSERT INTO luna_v2.messages (conversation_id, direction, sender_type, content, created_at)
       VALUES ($1, 'inbound', 'user', $2, NOW())`,
      [conversationId, userContent || '']
    );
    if (assistantContent) {
      await query(
        `INSERT INTO luna_v2.messages (conversation_id, direction, sender_type, agent_id, content, llm_latency_ms, model_used, tool_calls, created_at)
         VALUES ($1, 'outbound', 'agent', $2, $3, $4, $5, $6, NOW())`,
        [conversationId, agentId, assistantContent, llmLatencyMs, modelUsed, toolCalls]
      );
    }
    // Marca inbound + (se Luna respondeu) outbound + ack pra watchdog nao duplicar
    if (assistantContent) {
      await query(
        `UPDATE luna_v2.conversations
         SET last_message_at = NOW(),
             last_inbound_at = NOW(),
             last_outbound_at = NOW(),
             luna_ack_at = NOW(),
             attendance_status = COALESCE(NULLIF(attendance_status,''), 'open'),
             mensagens_count = COALESCE(mensagens_count, 0) + 2
         WHERE id = $1`,
        [conversationId]
      );
    } else {
      await query(
        `UPDATE luna_v2.conversations
         SET last_message_at = NOW(),
             last_inbound_at = NOW(),
             attendance_status = COALESCE(NULLIF(attendance_status,''), 'open'),
             mensagens_count = COALESCE(mensagens_count, 0) + 1
         WHERE id = $1`,
        [conversationId]
      );
    }
  } catch (e) {
    console.error('[luna-memory] persistTurn erro:', e.message);
  }
}

/**
 * Extrai fatos da conversa via DeepSeek (barato, bom em estruturacao)
 * Grava em luna_v2.memories
 */
export async function extractFactsAsync({ conversationId, clientId, userContent, assistantContent }) {
  try {
    if (!userContent || userContent.length < 8) return;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return;

    const prompt = `Voce e um extrator MUITO SELETIVO. Analise o turno de conversa e extraia SOMENTE fatos que atendam TODOS os criterios abaixo:

CRITERIOS (todos obrigatorios):
1. Fato DURAVEL (vai ser verdade em 30+ dias, nao demanda pontual)
2. Fato NAO capturado em outro sistema (CNPJ/CPF/nome/endereco vao pro Gesthub, NAO pra memoria)
3. Fato dito EXPLICITAMENTE pelo cliente (nao inferencia sua)
4. Fato UTIL pro atendimento futuro

ACEITAR APENAS estes tipos:
- "regra": solicitacao recorrente explicita ("quero o imposto todo dia 10", "me envie boleto por email")
- "erro": queixa sobre servico prestado ("minha nota esta errada", "boleto com valor errado")
- "preferencia": forma de tratamento/comunicacao ("me chame de Dr.", "prefiro whatsapp a email", "nao me ligue antes das 9h")
- "restricao": algo que o cliente NAO quer ("nao envie SMS", "nao quero X servico")

NUNCA extrair:
- Saudacoes, duvidas pontuais, confirmacoes
- Dados cadastrais (CNPJ, CPF, nome, endereco) - vao pro Gesthub
- Documentos enviados/recebidos - vira registro de documento, nao memoria
- Inferencias ou suposicoes suas
- Duplicatas de informacao ja conhecida

FORMATO (JSON array, sem explicacao):
[{"tipo":"regra|erro|preferencia|restricao","titulo":"curto","conteudo":"1 frase direta","prioridade":3-8,"confianca":0.85-1.0}]

Se NADA atende todos os criterios, responda: []

CLIENTE DISSE: ${userContent.slice(0, 800)}
LUNA RESPONDEU: ${String(assistantContent || '').slice(0, 400)}`;

    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) { console.error('[luna-memory] extract HTTP', res.status); return; }
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '[]';
    // aceita tanto array direto quanto {facts:[...]}
    let facts = [];
    try {
      const parsed = JSON.parse(raw);
      facts = Array.isArray(parsed) ? parsed : (parsed.facts || parsed.fatos || []);
    } catch { facts = []; }
    if (!Array.isArray(facts) || !facts.length) return;

    const ALLOWED_TIPOS = new Set(['regra','erro','preferencia','restricao']);
    let inserted = 0, skipped = 0;
    for (const f of facts.slice(0, 5)) {
      if (!f?.conteudo || !f?.titulo) { skipped++; continue; }
      const tipo = String(f.tipo || '').toLowerCase();
      if (!ALLOWED_TIPOS.has(tipo)) { skipped++; continue; }
      const confianca = Math.min(1, Math.max(0, parseFloat(f.confianca) || 0));
      if (confianca < 0.85) { skipped++; continue; }
      // dedup: mesmo tipo + titulo para mesma conv/cliente nos ultimos 30d
      const dup = await query(
        `SELECT 1 FROM luna_v2.memories
         WHERE tipo = $1 AND LOWER(titulo) = LOWER($2)
           AND (client_id = $3 OR trigger_ref = $4)
           AND created_at > now() - interval '30 days' LIMIT 1`,
        [tipo, (f.titulo || '').slice(0,200), clientId || null, conversationId || null]
      );
      if (dup.rows.length) { skipped++; continue; }
      await query(
        `INSERT INTO luna_v2.memories
           (tipo, titulo, conteudo, agent_id, client_id, prioridade, confianca, status, is_rag_enabled, trigger_type, trigger_ref)
         VALUES ($1, $2, $3, 'luna', $4, $5, $6, 'pending', false, 'conversation', $7)`,
        [
          tipo,
          (f.titulo || '').slice(0, 200),
          String(f.conteudo).slice(0, 1000),
          clientId || null,
          Math.min(10, Math.max(1, parseInt(f.prioridade) || 5)),
          confianca,
          conversationId || null,
        ]
      );
      inserted++;
    }
    console.log(`[luna-memory] extrator: ${inserted} inseridos, ${skipped} filtrados (total LLM: ${facts.length})`);
  } catch (e) {
    console.error('[luna-memory] extractFactsAsync erro:', e.message);
  }
}

export default { buildContext, persistTurn, extractFactsAsync, stripCtx };
