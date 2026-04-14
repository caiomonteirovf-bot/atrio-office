/**
 * Dara Orquestrador - Sistema Autônomo de Correção
 * Roda no servidor Atrio Office, monitora e corrige automaticamente
 */

const { query } = require('./db/pool');
const axios = require('axios');

const CONFIG = {
  OPENCLAW_URL: process.env.OPENCLAW_GATEWAY || 'http://localhost:18789',
  CHECK_INTERVAL: 60000, // 60 segundos
  MAX_RETRIES: 3,
  ENDPOINT_CORRECTIONS: {
    'http://localhost:3020/emitir': 'http://localhost:3020/api/nfses',
    'http://localhost:3020/nfse/emitir': 'http://localhost:3020/api/nfses',
    'http://nfse:3020/emitir': 'http://nfse:3020/api/nfses'
  }
};

/**
 * Loop principal do orquestrador
 */
async function orquestrar() {
  console.log('[Dara Orquestrador] Iniciando ciclo de verificação...');
  
  try {
    // 1. Verificar tasks travadas
    await verificarTasksTravadas();
    
    // 2. Verificar erros recentes
    await verificarErrosRecentes();
    
    // 3. Verificar saúde dos serviços
    await verificarSaudeServicos();
    
    console.log('[Dara Orquestrador] Ciclo concluído. Próximo em 60s...');
    
  } catch (error) {
    console.error('[Dara Orquestrador] Erro no ciclo:', error);
  }
}

/**
 * Verifica tasks travadas há mais de 5 minutos
 */
async function verificarTasksTravadas() {
  const tasks = await query(`
    SELECT * FROM luna_v2.tasks 
    WHERE status = 'processing' 
    AND updated_at < NOW() - INTERVAL '5 minutes'
    ORDER BY created_at ASC
    LIMIT 10
  `);
  
  for (const task of tasks.rows) {
    console.log(`[Dara] Task travada detectada: ${task.id} (${task.tipo})`);
    
    // Tentar recuperar baseado no tipo
    if (task.tipo === 'nfse_emitir') {
      await recuperarNfse(task);
    } else {
      // Resetar para pending para reprocessar
      await query(
        "UPDATE luna_v2.tasks SET status = 'pending', updated_at = NOW() WHERE id = $1",
        [task.id]
      );
      console.log(`[Dara] Task ${task.id} resetada para pending`);
    }
  }
}

/**
 * Verifica logs de erro recentes e aplica correções
 */
async function verificarErrosRecentes() {
  // Buscar tasks que falharam recentemente
  const erros = await query(`
    SELECT t.*, n.mensagem as erro_mensagem
    FROM luna_v2.tasks t
    LEFT JOIN luna_v2.notifications n ON n.task_id = t.id
    WHERE t.status = 'failed'
    AND t.updated_at > NOW() - INTERVAL '1 hour'
    AND t.retries < $1
    ORDER BY t.created_at DESC
    LIMIT 20
  `, [CONFIG.MAX_RETRIES]);
  
  for (const task of erros.rows) {
    const erroMsg = task.erro_mensagem || task.resultado || '';
    
    // Analisar tipo de erro e aplicar correção
    if (erroMsg.includes('404') || erroMsg.includes('Not Found')) {
      await corrigirErro404(task);
    } else if (erroMsg.includes('timeout') || erroMsg.includes('ECONNREFUSED')) {
      await corrigirTimeout(task);
    } else if (erroMsg.includes('prestador') || erroMsg.includes('cnpj')) {
      await corrigirDadosFaltando(task);
    }
  }
}

/**
 * Corrige erro 404 atualizando endpoint
 */
async function corrigirErro404(task) {
  console.log(`[Dara] Corrigindo erro 404 para task ${task.id}`);
  
  // Se for NFSe, atualizar payload com endpoint correto
  if (task.tipo === 'nfse_emitir') {
    const payload = typeof task.payload === 'string' 
      ? JSON.parse(task.payload) 
      : task.payload;
    
    // Marcar para usar endpoint correto
    payload.endpoint_corrigido = 'http://localhost:3020/api/nfses';
    payload.correcao_aplicada = 'url_nfse';
    
    await query(
      'UPDATE luna_v2.tasks SET payload = $1::jsonb, status = $2, retries = retries + 1 WHERE id = $3',
      [JSON.stringify(payload), 'pending', task.id]
    );
    
    // Log da correção
    await logCorrecao(task.id, 'endpoint_404', '/emitir → /api/nfses');
    console.log(`[Dara] Endpoint corrigido para task ${task.id}`);
    
    // Tentar reexecutar imediatamente
    await reexecutarTask(task);
  }
}

/**
 * Corrige timeout tentando endpoint alternativo
 */
async function corrigirTimeout(task) {
  console.log(`[Dara] Corrigindo timeout para task ${task.id}`);
  
  await query(
    "UPDATE luna_v2.tasks SET status = 'pending', retries = retries + 1, updated_at = NOW() WHERE id = $1",
    [task.id]
  );
  
  await logCorrecao(task.id, 'timeout_retry', 'Resetado para retry');
}

/**
 * Corrige dados faltando buscando em fontes alternativas
 */
async function corrigirDadosFaltando(task) {
  console.log(`[Dara] Buscando dados faltando para task ${task.id}`);
  
  const payload = typeof task.payload === 'string' 
    ? JSON.parse(task.payload) 
    : task.payload;
  
  // Se falta prestador_cnpj, tentar buscar pelo telefone
  if (!payload.prestador_cnpj && payload.phone) {
    const busca = await buscarPrestadorPorTelefone(payload.phone);
    
    if (busca.encontrado) {
      Object.assign(payload, busca.dados);
      
      await query(
        'UPDATE luna_v2.tasks SET payload = $1::jsonb, status = $2 WHERE id = $3',
        [JSON.stringify(payload), 'pending', task.id]
      );
      
      await logCorrecao(task.id, 'dados_completados', 'Prestador encontrado pelo telefone');
      console.log(`[Dara] Dados completados para task ${task.id}`);
      
      // Reexecutar
      await reexecutarTask(task);
    }
  }
}

/**
 * Busca prestador pelo telefone
 */
async function buscarPrestadorPorTelefone(phone) {
  try {
    const phoneLimpo = phone.replace('@c.us', '').replace(/\D/g, '');
    
    const r1 = await query(
      `SELECT nome_legal, cnpj FROM luna_v2.clients 
       WHERE contatos @> $1::jsonb LIMIT 1`,
      [JSON.stringify([{ tipo: 'whatsapp', valor: phoneLimpo }])]
    );
    
    if (r1.rows.length > 0) {
      return {
        encontrado: true,
        dados: {
          prestador_cnpj: r1.rows[0].cnpj,
          prestador_nome: r1.rows[0].nome_legal
        }
      };
    }
    
    return { encontrado: false };
  } catch (e) {
    return { encontrado: false };
  }
}

/**
 * Recupera NFSe travada
 */
async function recuperarNfse(task) {
  console.log(`[Dara] Recuperando NFSe ${task.id}`);
  
  // Resetar para pending com correção
  const payload = typeof task.payload === 'string' 
    ? JSON.parse(task.payload) 
    : task.payload || {};
  
  payload.endpoint_corrigido = 'http://localhost:3020/api/nfses';
  payload.recuperacao_automatica = true;
  
  await query(
    'UPDATE luna_v2.tasks SET payload = $1::jsonb, status = $2, updated_at = NOW() WHERE id = $3',
    [JSON.stringify(payload), 'pending', task.id]
  );
  
  await logCorrecao(task.id, 'recuperacao_nfse', 'Task travada resetada');
}

/**
 * Reexecuta uma task
 */
async function reexecutarTask(task) {
  console.log(`[Dara] Reexecutando task ${task.id}`);
  
  // Aqui você chamaria o processador real
  // Por enquanto, só marca para reprocessamento
  await query(
    "UPDATE luna_v2.tasks SET status = 'pending', updated_at = NOW() WHERE id = $1",
    [task.id]
  );
}

/**
 * Verifica saúde dos serviços externos
 */
async function verificarSaudeServicos() {
  const servicos = [
    { nome: 'NFS-e System', url: 'http://localhost:3020/api/health', timeout: 5000 },
    { nome: 'OpenClaw', url: 'http://localhost:18789/api/status', timeout: 5000 }
  ];
  
  for (const servico of servicos) {
    try {
      const response = await axios.get(servico.url, { timeout: servico.timeout });
      console.log(`[Dara Health] ${servico.nome}: OK`);
    } catch (error) {
      console.error(`[Dara Health] ${servico.nome}: INDISPONÍVEL`);
      
      // Notificar equipe
      await query(
        `INSERT INTO luna_v2.notifications 
         (tipo, team_member_id, titulo, mensagem, status, created_at)
         VALUES ('system_alert', 'admin', 'Serviço Indisponível', $1, 'unread', NOW())`,
        [`${servico.nome} está indisponível: ${error.message}`]
      );
    }
  }
}

/**
 * Log de correções aplicadas
 */
async function logCorrecao(taskId, tipo, descricao) {
  await query(
    `INSERT INTO luna_v2.memory_suggestions 
     (tipo, contexto, validado, created_at)
     VALUES ($1, $2, true, NOW())`,
    [`correcao_${tipo}`, JSON.stringify({ task_id: taskId, descricao, timestamp: new Date().toISOString() })]
  );
}

/**
 * Inicia o orquestrador
 */
function iniciar() {
  console.log('[Dara Orquestrador] Iniciando...');
  console.log('[Dara Orquestrador] Verificando a cada', CONFIG.CHECK_INTERVAL/1000, 'segundos');
  
  // Primeira execução imediata
  orquestrar();
  
  // Loop contínuo
  setInterval(orquestrar, CONFIG.CHECK_INTERVAL);
}

// Exportar
module.exports = { iniciar, orquestrar };

// Se executado diretamente
if (require.main === module) {
  iniciar();
}
