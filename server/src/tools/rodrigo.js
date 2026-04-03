import { query } from '../db/pool.js';

// Mapa de agent_id fixos do seed
const AGENT_IDS = {
  rodrigo: 'a0000001-0000-0000-0000-000000000001',
  campelo: 'a0000001-0000-0000-0000-000000000002',
  sneijder: 'a0000001-0000-0000-0000-000000000003',
  luna: 'a0000001-0000-0000-0000-000000000004',
  sofia: 'a0000001-0000-0000-0000-000000000005',
};

async function resolveTeamMember(nameOrId) {
  // Tenta por UUID
  if (nameOrId?.match(/^[0-9a-f-]{36}$/i)) {
    const { rows } = await query('SELECT id, name FROM team_members WHERE id = $1', [nameOrId]);
    return rows[0] || null;
  }
  // Tenta por nome (case-insensitive)
  const { rows } = await query(
    'SELECT id, name FROM team_members WHERE LOWER(name) = LOWER($1)',
    [nameOrId]
  );
  return rows[0] || null;
}

export const tools = {
  // ============================================
  // STATUS_EQUIPE — Consulta status de todos
  // ============================================
  async status_equipe() {
    const { rows } = await query(`
      SELECT tm.name, tm.type, tm.role, tm.department, tm.status,
             a.status as agent_status
      FROM team_members tm
      LEFT JOIN agents a ON tm.agent_id = a.id
      ORDER BY tm.type, tm.name
    `);
    return {
      total: rows.length,
      online: rows.filter(r => r.status === 'available').length,
      equipe: rows.map(r => ({
        nome: r.name,
        tipo: r.type === 'ai' ? 'IA' : 'Humano',
        cargo: r.role,
        setor: r.department,
        status: r.status,
      })),
    };
  },

  // ============================================
  // FILA_PRIORIDADES — Tasks pendentes por prioridade
  // ============================================
  async fila_prioridades() {
    const { rows } = await query(`
      SELECT t.id, t.title, t.priority, t.status, t.due_date, t.created_at,
             tm.name as responsavel, c.name as cliente
      FROM tasks t
      LEFT JOIN team_members tm ON t.assigned_to = tm.id
      LEFT JOIN clients c ON t.client_id = c.id
      WHERE t.status IN ('pending', 'in_progress')
      ORDER BY
        CASE t.priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END,
        t.created_at DESC
      LIMIT 20
    `);
    const { rows: countRows } = await query(
      `SELECT COUNT(*) as total FROM tasks WHERE status IN ('pending', 'in_progress')`
    );
    return {
      total: parseInt(countRows[0].total),
      mostrando: rows.length,
      tarefas: rows.map(r => ({
        id: r.id,
        titulo: r.title,
        prioridade: r.priority,
        status: r.status,
        responsavel: r.responsavel || 'Não atribuído',
        cliente: r.cliente || '—',
        prazo: r.due_date ? new Date(r.due_date).toLocaleDateString('pt-BR') : 'Sem prazo',
        criada_em: new Date(r.created_at).toLocaleDateString('pt-BR'),
      })),
    };
  },

  // ============================================
  // DELEGAR_TAREFA — Cria e delega task
  // ============================================
  async delegar_tarefa({ titulo, responsavel, descricao, prioridade, prazo, cliente_id }) {
    if (!titulo || !responsavel) {
      return { erro: 'Parâmetros obrigatórios: titulo e responsavel' };
    }

    const member = await resolveTeamMember(responsavel);
    if (!member) {
      return { erro: `Membro "${responsavel}" não encontrado na equipe` };
    }

    // Rodrigo como delegator
    const { rows: rodrigoRows } = await query(
      `SELECT tm.id FROM team_members tm WHERE tm.agent_id = $1`,
      [AGENT_IDS.rodrigo]
    );
    const rodrigoMemberId = rodrigoRows[0]?.id;

    const { rows } = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, client_id, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        titulo,
        descricao || null,
        member.id,
        rodrigoMemberId,
        cliente_id || null,
        prioridade || 'medium',
        prazo || null,
      ]
    );

    return {
      sucesso: true,
      tarefa: {
        id: rows[0].id,
        titulo: rows[0].title,
        delegada_para: member.name,
        prioridade: rows[0].priority,
        status: rows[0].status,
      },
    };
  },

  // ============================================
  // RELATORIO_DIARIO — Produtividade do dia
  // ============================================
  async relatorio_diario() {
    const { rows: statusCounts } = await query(`
      SELECT status, COUNT(*) as count FROM tasks
      WHERE DATE(updated_at) = CURRENT_DATE OR DATE(created_at) = CURRENT_DATE
      GROUP BY status
    `);

    const { rows: perMember } = await query(`
      SELECT tm.name, tm.type, t.status, COUNT(*) as count
      FROM tasks t
      JOIN team_members tm ON t.assigned_to = tm.id
      WHERE DATE(t.updated_at) = CURRENT_DATE OR DATE(t.created_at) = CURRENT_DATE
      GROUP BY tm.name, tm.type, t.status
      ORDER BY tm.name
    `);

    const resumo = {};
    statusCounts.forEach(r => { resumo[r.status] = parseInt(r.count); });

    const porMembro = {};
    perMember.forEach(r => {
      if (!porMembro[r.name]) porMembro[r.name] = { tipo: r.type === 'ai' ? 'IA' : 'Humano' };
      porMembro[r.name][r.status] = parseInt(r.count);
    });

    return {
      data: new Date().toLocaleDateString('pt-BR'),
      resumo,
      por_membro: porMembro,
    };
  },

  // ============================================
  // AGENDA_PRAZOS — Prazos próximos
  // ============================================
  async agenda_prazos({ dias }) {
    const intervalo = dias || 7;
    const { rows } = await query(`
      SELECT t.title, t.priority, t.status, t.due_date,
             tm.name as responsavel, c.name as cliente
      FROM tasks t
      LEFT JOIN team_members tm ON t.assigned_to = tm.id
      LEFT JOIN clients c ON t.client_id = c.id
      WHERE t.due_date IS NOT NULL
        AND t.due_date BETWEEN NOW() AND NOW() + ($1 || ' days')::interval
        AND t.status NOT IN ('done', 'cancelled')
      ORDER BY t.due_date ASC
      LIMIT 20
    `, [intervalo]);

    return {
      periodo: `Próximos ${intervalo} dias`,
      total: rows.length,
      prazos: rows.map(r => ({
        titulo: r.title,
        prazo: new Date(r.due_date).toLocaleDateString('pt-BR'),
        prioridade: r.priority,
        responsavel: r.responsavel || 'Não atribuído',
        cliente: r.cliente || '—',
      })),
    };
  },

  // ============================================
  // ESCALAR_PARA_CAIO — Notificação urgente
  // ============================================
  async escalar_para_caio({ motivo, contexto }) {
    if (!motivo) {
      return { erro: 'Parâmetro obrigatório: motivo' };
    }

    const { rows: rodrigoRows } = await query(
      `SELECT tm.id FROM team_members tm WHERE tm.agent_id = $1`,
      [AGENT_IDS.rodrigo]
    );

    const { rows } = await query(
      `INSERT INTO tasks (title, description, priority, status, delegated_by, result)
       VALUES ($1, $2, 'urgent', 'pending', $3, $4) RETURNING id`,
      [
        `[ESCALAÇÃO] ${motivo}`,
        contexto || motivo,
        rodrigoRows[0]?.id,
        JSON.stringify({ tipo: 'escalacao', motivo, timestamp: new Date().toISOString() }),
      ]
    );

    return {
      sucesso: true,
      mensagem: `Escalação registrada para Caio com prioridade URGENTE.`,
      task_id: rows[0].id,
    };
  },

  // ============================================
  // ROTEAR_DEMANDA — Classificar e encaminhar
  // ============================================
  async rotear_demanda({ descricao, tipo, prioridade }) {
    if (!descricao) {
      return { erro: 'Parâmetro obrigatório: descricao' };
    }

    // Mapa de tipos para agentes
    const roteamento = {
      fiscal: { nome: 'Campelo', agentId: AGENT_IDS.campelo },
      financeiro: { nome: 'Sneijder', agentId: AGENT_IDS.sneijder },
      atendimento: { nome: 'Luna', agentId: AGENT_IDS.luna },
      societario: { nome: 'Sofia', agentId: AGENT_IDS.sofia },
    };

    const destino = roteamento[tipo] || roteamento.atendimento;

    // Resolve team member ID do agente destino
    const { rows: memberRows } = await query(
      `SELECT tm.id FROM team_members tm WHERE tm.agent_id = $1`,
      [destino.agentId]
    );

    const { rows: rodrigoRows } = await query(
      `SELECT tm.id FROM team_members tm WHERE tm.agent_id = $1`,
      [AGENT_IDS.rodrigo]
    );

    const { rows } = await query(
      `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, title`,
      [
        descricao.substring(0, 255),
        descricao,
        memberRows[0]?.id,
        rodrigoRows[0]?.id,
        prioridade || 'medium',
      ]
    );

    return {
      sucesso: true,
      roteada_para: destino.nome,
      tipo,
      tarefa_id: rows[0].id,
    };
  },
};
