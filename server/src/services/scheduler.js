import * as gesthub from './gesthub.js';
import * as omie from './omie.js';
import * as whatsapp from './whatsapp.js';
import { query } from '../db/pool.js';

const TIMEZONE = 'America/Recife';

function now() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

function log(msg) {
  const time = now().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  console.log(`[Scheduler ${time}] ${msg}`);
}

// ============================================
// VERIFICAÇÃO DE INADIMPLÊNCIA (OMIE — dados reais)
// ============================================
async function checkInadimplencia() {
  if (!omie.isConfigured()) {
    log('Omie não configurado — pulando verificação de inadimplência');
    return [];
  }

  log('Verificando inadimplência (Omie)...');

  try {
    const vencidos = await omie.listarContasReceber({ apenasVencidos: true });

    if (vencidos.length > 0) {
      const total = vencidos.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
      const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      log(`${vencidos.length} títulos vencidos — total: ${fmt(total)}`);

      // Verifica se já existe task para isso hoje
      const { rows: existing } = await query(
        `SELECT id FROM tasks WHERE title LIKE '%inadimplência Omie%' AND DATE(created_at) = CURRENT_DATE`
      );

      if (existing.length === 0) {
        const { rows: rodrigo } = await query(
          `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Rodrigo'`
        );
        const { rows: sneijder } = await query(
          `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Sneijder'`
        );

        const lista = vencidos.slice(0, 15).map(t =>
          `- Cliente #${t.codigo_cliente_fornecedor}: ${fmt(t.valor_documento)} (venc: ${t.data_vencimento})`
        ).join('\n');

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result)
           VALUES ($1, $2, $3, $4, 'high', 'pending', $5)`,
          [
            `${vencidos.length} títulos em inadimplência Omie — ${fmt(total)}`,
            `Títulos vencidos (dados reais Omie):\n\n${lista}${vencidos.length > 15 ? `\n... e mais ${vencidos.length - 15} títulos` : ''}`,
            sneijder[0]?.id,
            rodrigo[0]?.id,
            JSON.stringify({ tipo: 'inadimplencia_omie', total, qtd: vencidos.length }),
          ]
        );
        log('Task de inadimplência criada para Sneijder');
      }

      return vencidos;
    } else {
      log('Nenhum título vencido');
      return [];
    }
  } catch (err) {
    log(`ERRO inadimplência: ${err.message}`);
    return [];
  }
}

// ============================================
// CONTAS A PAGAR PRÓXIMAS (OMIE — dados reais)
// ============================================
async function checkContasPagar() {
  if (!omie.isConfigured()) return [];

  log('Verificando contas a pagar (Omie)...');

  try {
    const proximas = await omie.contasVencendoProximosDias(5);

    if (proximas.length > 0) {
      const total = proximas.reduce((s, t) => s + Number(t.valor_documento || 0), 0);
      const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      log(`${proximas.length} contas a pagar vencendo em 5 dias — total: ${fmt(total)}`);

      // Verifica se já existe task hoje
      const { rows: existing } = await query(
        `SELECT id FROM tasks WHERE title LIKE '%contas a pagar Omie%' AND DATE(created_at) = CURRENT_DATE`
      );

      if (existing.length === 0 && proximas.length > 0) {
        const { rows: rodrigo } = await query(
          `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Rodrigo'`
        );
        const { rows: sneijder } = await query(
          `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Sneijder'`
        );

        const lista = proximas.slice(0, 10).map(t =>
          `- Fornecedor #${t.codigo_cliente_fornecedor}: ${fmt(t.valor_documento)} (venc: ${t.data_vencimento})`
        ).join('\n');

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
          [
            `${proximas.length} contas a pagar Omie vencendo — ${fmt(total)}`,
            `Contas a pagar nos próximos 5 dias (dados reais Omie):\n\n${lista}`,
            sneijder[0]?.id,
            rodrigo[0]?.id,
            proximas.some(t => {
              const v = t.data_vencimento?.split('/');
              if (!v || v.length !== 3) return false;
              const diff = (new Date(v[2], v[1] - 1, v[0]) - now()) / (1000 * 60 * 60 * 24);
              return diff <= 2;
            }) ? 'urgent' : 'high',
            JSON.stringify({ tipo: 'contas_pagar_omie', total, qtd: proximas.length }),
          ]
        );
        log('Task de contas a pagar criada para Sneijder');
      }

      return proximas;
    } else {
      log('Nenhuma conta a pagar vencendo em 5 dias');
      return [];
    }
  } catch (err) {
    log(`ERRO contas a pagar: ${err.message}`);
    return [];
  }
}

// ============================================
// CLIENTES SEM HONORÁRIO (GESTHUB — dado real)
// ============================================
async function checkSemHonorario() {
  log('Verificando clientes sem honorário (Gesthub)...');

  try {
    const clients = await gesthub.getClients();
    const semHonorario = clients.filter(c =>
      c.status === 'ATIVO' && (!c.monthlyFee || c.monthlyFee === 0)
    );

    if (semHonorario.length > 0) {
      log(`${semHonorario.length} clientes ativos sem honorário definido`);

      const { rows: existing } = await query(
        `SELECT id FROM tasks WHERE title LIKE '%sem honorário%' AND DATE(created_at) = CURRENT_DATE`
      );

      if (existing.length === 0) {
        const { rows: rodrigo } = await query(
          `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Rodrigo'`
        );
        const { rows: sneijder } = await query(
          `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Sneijder'`
        );

        const lista = semHonorario.slice(0, 20).map(c =>
          `- ${c.legalName?.substring(0, 40)} (${c.document})`
        ).join('\n');

        await query(
          `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status)
           VALUES ($1, $2, $3, $4, 'medium', 'pending')`,
          [
            `${semHonorario.length} clientes ativos sem honorário definido`,
            `Clientes que precisam ter honorário cadastrado:\n\n${lista}`,
            sneijder[0]?.id,
            rodrigo[0]?.id,
          ]
        );
        log('Task de honorários criada para Sneijder');
      }
    }

    return semHonorario;
  } catch (err) {
    log(`ERRO honorários: ${err.message}`);
    return [];
  }
}

// ============================================
// ALERTAS FISCAIS PROATIVOS (CAMPELO)
// ============================================

const CALENDARIO_FISCAL = [
  { obrigacao: 'DAS (Simples Nacional)', dia: 20, regime: 'simples', descricao: 'Guia do Simples Nacional' },
  { obrigacao: 'DARF IRPJ/CSLL', dia: 30, regime: 'presumido', descricao: 'Trimestral: mar, jun, set, dez', trimestral: true, mesesTrim: [3, 6, 9, 12] },
  { obrigacao: 'DARF PIS', dia: 25, regime: 'presumido', descricao: 'PIS sobre faturamento' },
  { obrigacao: 'DARF COFINS', dia: 25, regime: 'presumido', descricao: 'COFINS sobre faturamento' },
  { obrigacao: 'DARF ISS', dia: 15, regime: 'todos', descricao: 'ISS municipal' },
  { obrigacao: 'FGTS/GFIP', dia: 7, regime: 'todos', descricao: 'Recolhimento FGTS + GFIP' },
  { obrigacao: 'INSS (GPS)', dia: 20, regime: 'todos', descricao: 'Contribuição previdenciária' },
  { obrigacao: 'DEFIS', dia: 31, regime: 'simples', descricao: 'Declaração anual Simples', meses: [3] },
  { obrigacao: 'DIRF', dia: 28, regime: 'todos', descricao: 'Declaração IR retido na fonte', meses: [2] },
];

function mapRegime(taxRegime) {
  if (!taxRegime) return null;
  const r = taxRegime.toUpperCase();
  if (r.includes('SIMPLES') || r.includes('MEI')) return 'simples';
  if (r.includes('PRESUMIDO')) return 'presumido';
  if (r.includes('REAL')) return 'real';
  return null;
}

async function checkAlertasFiscais() {
  log('Verificando prazos fiscais por cliente (Campelo proativo)...');

  try {
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO' && c.document);
    const hoje = now();
    const mes = hoje.getMonth() + 1;
    const ano = hoje.getFullYear();

    const alertas = [];

    for (const obr of CALENDARIO_FISCAL) {
      // Filtrar por meses específicos (DEFIS só em março, etc.)
      if (obr.meses && !obr.meses.includes(mes)) continue;
      // Trimestral: só nos meses do trimestre
      if (obr.trimestral && obr.mesesTrim && !obr.mesesTrim.includes(mes)) continue;

      const diaVenc = Math.min(obr.dia, 28);
      const vencimento = new Date(ano, mes - 1, diaVenc);
      const diasRestantes = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));

      // Só alertar se vence nos próximos 5 dias (ou já venceu este mês)
      if (diasRestantes > 5 || diasRestantes < -5) continue;

      // Filtra clientes pelo regime da obrigação
      const clientesAfetados = ativos.filter(c => {
        const regime = mapRegime(c.taxRegime);
        if (obr.regime === 'todos') return true;
        if (obr.regime === 'simples') return regime === 'simples';
        if (obr.regime === 'presumido') return regime === 'presumido' || regime === 'real';
        return false;
      });

      if (clientesAfetados.length === 0) continue;

      alertas.push({
        obrigacao: obr.obrigacao,
        descricao: obr.descricao,
        vencimento: vencimento.toLocaleDateString('pt-BR'),
        diasRestantes,
        status: diasRestantes < 0 ? 'VENCIDO' : diasRestantes <= 2 ? 'URGENTE' : 'ATENÇÃO',
        clientes: clientesAfetados.length,
        listaClientes: clientesAfetados.slice(0, 10).map(c => c.legalName?.substring(0, 40) || c.document),
      });
    }

    if (alertas.length === 0) {
      log('Nenhum prazo fiscal próximo (5 dias)');
      return [];
    }

    log(`${alertas.length} obrigação(ões) fiscal(is) vencendo em 5 dias`);

    // Verifica se já criou task de alertas fiscais hoje
    const { rows: existing } = await query(
      `SELECT id FROM tasks WHERE title LIKE '%Alertas fiscais%' AND DATE(created_at) = CURRENT_DATE`
    );

    if (existing.length === 0) {
      const { rows: rodrigo } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Rodrigo'`
      );
      const { rows: campelo } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Campelo'`
      );

      const urgentes = alertas.filter(a => a.status === 'VENCIDO' || a.status === 'URGENTE');
      const prioridade = urgentes.length > 0 ? 'urgent' : 'high';

      const corpo = alertas.map(a => {
        const flag = a.status === 'VENCIDO' ? '🔴' : a.status === 'URGENTE' ? '🟠' : '🟡';
        return `${flag} **${a.obrigacao}** — venc: ${a.vencimento} (${a.diasRestantes}d)\n   ${a.clientes} cliente(s): ${a.listaClientes.join(', ')}`;
      }).join('\n\n');

      await query(
        `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status, result)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [
          `Alertas fiscais — ${alertas.length} obrigação(ões) vencendo`,
          `Prazos fiscais próximos (${hoje.toLocaleDateString('pt-BR')}):\n\n${corpo}`,
          campelo[0]?.id,
          rodrigo[0]?.id,
          prioridade,
          JSON.stringify({ tipo: 'alertas_fiscais', alertas }),
        ]
      );
      log(`Task de alertas fiscais criada para Campelo (${prioridade})`);
    }

    return alertas;
  } catch (err) {
    log(`ERRO alertas fiscais: ${err.message}`);
    return [];
  }
}

// ============================================
// CLIENTES COM DADOS INCOMPLETOS (FEEDBACK LOOP)
// ============================================
async function checkDadosIncompletos() {
  log('Verificando clientes com dados incompletos (Gesthub)...');

  try {
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO');

    const incompletos = ativos.filter(c => {
      const falta = [];
      if (!c.taxRegime || c.taxRegime === '--') falta.push('regime');
      if (!c.email) falta.push('email');
      if (!c.phone) falta.push('telefone');
      if (!c.city || c.city === '--') falta.push('cidade');
      return falta.length >= 2; // Pelo menos 2 campos faltando
    });

    if (incompletos.length === 0) {
      log('Todos os clientes ativos com dados suficientes');
      return [];
    }

    log(`${incompletos.length} clientes com dados incompletos`);

    // Só cria task 1x por semana (segunda-feira)
    const dayOfWeek = now().getDay();
    if (dayOfWeek !== 1) return incompletos; // 1 = segunda

    const { rows: existing } = await query(
      `SELECT id FROM tasks WHERE title LIKE '%dados incompletos%' AND created_at > NOW() - INTERVAL '6 days'`
    );

    if (existing.length === 0) {
      const { rows: rodrigo } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Rodrigo'`
      );
      const { rows: luna } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Luna'`
      );

      const lista = incompletos.slice(0, 15).map(c => {
        const falta = [];
        if (!c.taxRegime || c.taxRegime === '--') falta.push('regime');
        if (!c.email) falta.push('email');
        if (!c.phone) falta.push('telefone');
        if (!c.city || c.city === '--') falta.push('cidade');
        return `- ${c.legalName?.substring(0, 50)} (${c.document || 'sem CNPJ'}) — falta: ${falta.join(', ')}`;
      }).join('\n');

      const { rows: created } = await query(
        `INSERT INTO tasks (title, description, assigned_to, delegated_by, priority, status)
         VALUES ($1, $2, $3, $4, 'low', 'in_progress') RETURNING id`,
        [
          `${incompletos.length} clientes com dados incompletos`,
          `Clientes ativos com campos faltando (enriquecer via RF ou solicitar ao cliente):\n\n${lista}${incompletos.length > 15 ? `\n... e mais ${incompletos.length - 15}` : ''}`,
          luna[0]?.id,
          rodrigo[0]?.id,
        ]
      );
      const taskId = created[0]?.id;
      log(`Task semanal de dados incompletos criada (${taskId}) — iniciando enrich automático`);

      // Loop fechado: tenta resolver via Receita Federal, só mantém pendente o que falhar
      if (taskId) {
        try {
          const { enrichTaskById } = await import('./task-enricher.js');
          enrichTaskById(taskId, {
            rewriteDescription: true,
            completeIfAllOk: true,
          }).then(sum => {
            log(`[auto-enrich] task ${taskId}: ${sum.sucesso?.length || 0} OK, ${sum.falha?.length || 0} falhas, ${sum.naoEncontrado?.length || 0} nao_encontrados`);
          }).catch(e => log(`[auto-enrich] falhou: ${e.message}`));
        } catch (e) { log(`[auto-enrich] import falhou: ${e.message}`); }
      }
    }

    return incompletos;
  } catch (err) {
    log(`ERRO dados incompletos: ${err.message}`);
    return [];
  }
}

// ============================================
// SCHEDULER PRINCIPAL
// ============================================
let schedulerInterval = null;
let dailyRanAt = null;

export function start() {
  log('Scheduler iniciado (apenas dados reais: Omie + Gesthub)');

  // Roda verificações a cada hora
  schedulerInterval = setInterval(async () => {
    const h = now().getHours();
    const today = now().toDateString();

    // Verificações diárias às 8h (só 1x por dia)
    if (h === 8 && dailyRanAt !== today) {
      dailyRanAt = today;
      log('=== Verificações diárias (dados reais) ===');
      await checkInadimplencia();
      await checkContasPagar();
      await checkSemHonorario();
      // await checkAlertasFiscais(); // Standby — foco em atendimento e emissão
      await checkDadosIncompletos();
    }
  }, 60 * 60 * 1000);

  // Roda imediatamente se for após 8h e ainda não rodou hoje
  const h = now().getHours();
  if (h >= 8 && dailyRanAt !== now().toDateString()) {
    dailyRanAt = now().toDateString();
    log('Rodando verificações iniciais (dados reais)...');
    checkInadimplencia();
    checkContasPagar();
    checkSemHonorario();
    // checkAlertasFiscais(); // Standby — foco em atendimento e emissão
    checkDadosIncompletos();
  }
}

export function stop() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  log('Scheduler parado');
}

export { checkInadimplencia, checkContasPagar, checkSemHonorario, checkAlertasFiscais, checkDadosIncompletos };
