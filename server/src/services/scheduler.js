import * as gesthub from './gesthub.js';
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
// CALENDÁRIO FISCAL POR REGIME
// ============================================
const CALENDARIO = {
  MEI: [
    { dia: 20, nome: 'DAS-MEI', descricao: 'Guia do MEI' },
  ],
  'SIMPLES NACIONAL': [
    { dia: 20, nome: 'DAS', descricao: 'Guia do Simples Nacional' },
    { dia: 15, nome: 'PGDAS-D', descricao: 'Declaração mensal Simples' },
  ],
  PRESUMIDO: [
    { dia: 25, nome: 'PIS/COFINS', descricao: 'DARF PIS e COFINS' },
    { dia: 15, nome: 'EFD-Contribuições', descricao: 'Escrituração digital' },
    { dia: 15, nome: 'DCTF', descricao: 'Declaração de débitos tributários' },
    { dia: 30, nome: 'IRPJ/CSLL', descricao: 'Trimestral (mar, jun, set, dez)' },
  ],
  REAL: [
    { dia: 25, nome: 'PIS/COFINS', descricao: 'DARF PIS e COFINS' },
    { dia: 15, nome: 'EFD-Contribuições', descricao: 'Escrituração digital' },
    { dia: 15, nome: 'DCTF', descricao: 'Declaração de débitos tributários' },
    { dia: 30, nome: 'IRPJ/CSLL', descricao: 'Trimestral' },
    { dia: 15, nome: 'ECF', descricao: 'Escrituração Contábil Fiscal' },
  ],
  TODOS: [
    { dia: 7, nome: 'FGTS', descricao: 'Recolhimento FGTS' },
    { dia: 20, nome: 'INSS', descricao: 'Contribuição previdenciária' },
  ],
};

// ============================================
// VERIFICAÇÃO DE PRAZOS FISCAIS
// ============================================
async function checkPrazosFiscais() {
  log('Verificando prazos fiscais...');

  try {
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO');
    const hoje = now();
    const diaHoje = hoje.getDate();
    const mesHoje = hoje.getMonth();

    const alertas = [];

    for (const client of ativos) {
      const regime = client.taxRegime?.toUpperCase() || '';
      const obrigacoes = [
        ...(CALENDARIO[regime] || []),
        ...CALENDARIO.TODOS,
      ];

      for (const obg of obrigacoes) {
        const diasRestantes = obg.dia - diaHoje;

        // Alerta 5 dias antes do vencimento
        if (diasRestantes > 0 && diasRestantes <= 5) {
          alertas.push({
            client: client.legalName?.substring(0, 40),
            clientId: client.id,
            cnpj: client.document,
            phone: client.phone,
            regime,
            obrigacao: obg.nome,
            descricao: obg.descricao,
            vencimento: obg.dia,
            diasRestantes,
            responsavel: client.analyst || client.officeOwner,
          });
        }
      }
    }

    if (alertas.length > 0) {
      log(`${alertas.length} obrigações vencendo nos próximos 5 dias`);

      // Agrupa por responsável
      const porResponsavel = {};
      alertas.forEach(a => {
        const resp = a.responsavel || 'Sem responsável';
        if (!porResponsavel[resp]) porResponsavel[resp] = [];
        porResponsavel[resp].push(a);
      });

      // Cria tasks para equipe
      for (const [resp, lista] of Object.entries(porResponsavel)) {
        const resumo = lista.map(a =>
          `- ${a.obrigacao} (${a.client}) vence dia ${a.vencimento} (${a.diasRestantes}d)`
        ).join('\n');

        // Busca Rodrigo team member ID
        const { rows: rodrigo } = await query(
          `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Rodrigo'`
        );

        await query(
          `INSERT INTO tasks (title, description, priority, delegated_by, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [
            `Prazos fiscais próximos — ${resp} (${lista.length} obrigações)`,
            `Obrigações vencendo nos próximos 5 dias:\n\n${resumo}`,
            lista.some(a => a.diasRestantes <= 2) ? 'urgent' : 'high',
            rodrigo[0]?.id,
          ]
        );
      }

      // Notifica no grupo WhatsApp
      if (whatsapp.getStatus().connected) {
        const resumoGeral = alertas.slice(0, 10).map(a =>
          `• ${a.obrigacao} — ${a.client?.substring(0, 25)} (dia ${a.vencimento})`
        ).join('\n');

        // Notifica internamente via broadcast
        log(`Alertas criados para ${Object.keys(porResponsavel).length} responsáveis`);
      }
    } else {
      log('Nenhuma obrigação vencendo nos próximos 5 dias');
    }

    return alertas;
  } catch (err) {
    log(`ERRO prazos fiscais: ${err.message}`);
    return [];
  }
}

// ============================================
// VERIFICAÇÃO DE INADIMPLÊNCIA
// ============================================
async function checkInadimplencia() {
  log('Verificando inadimplência...');

  try {
    const clients = await gesthub.getClients();
    const semHonorario = clients.filter(c =>
      c.status === 'ATIVO' && (!c.monthlyFee || c.monthlyFee === 0)
    );

    if (semHonorario.length > 0) {
      log(`${semHonorario.length} clientes ativos sem honorário definido`);

      const { rows: rodrigo } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Rodrigo'`
      );
      const { rows: sneijder } = await query(
        `SELECT tm.id FROM team_members tm JOIN agents a ON tm.agent_id = a.id WHERE a.name = 'Sneijder'`
      );

      // Verifica se já existe task para isso hoje
      const { rows: existing } = await query(
        `SELECT id FROM tasks WHERE title LIKE '%sem honorário%' AND DATE(created_at) = CURRENT_DATE`
      );

      if (existing.length === 0) {
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
        log('Task de inadimplência criada para Sneijder');
      }
    }
  } catch (err) {
    log(`ERRO inadimplência: ${err.message}`);
  }
}

// ============================================
// LEMBRETES WHATSAPP PARA CLIENTES
// ============================================
async function sendClientReminders() {
  if (!whatsapp.getStatus().connected) return;

  log('Verificando lembretes para clientes...');

  try {
    const clients = await gesthub.getClients();
    const ativos = clients.filter(c => c.status === 'ATIVO' && c.phone);
    const hoje = now();
    const diaHoje = hoje.getDate();

    let enviados = 0;

    for (const client of ativos) {
      const regime = client.taxRegime?.toUpperCase() || '';

      // DAS/DAS-MEI vence dia 20 — lembrete dia 15
      if ((regime === 'MEI' || regime === 'SIMPLES NACIONAL') && diaHoje === 15) {
        const phone = client.phone.replace(/\D/g, '');
        if (phone.length >= 10) {
          try {
            await whatsapp.sendMessage(phone,
              `Olá! Lembrete: sua guia ${regime === 'MEI' ? 'DAS-MEI' : 'DAS'} vence no dia 20. Precisa que enviemos a guia? Responda SIM que providenciamos! 😊`
            );
            enviados++;
          } catch {}
        }
      }
    }

    if (enviados > 0) log(`${enviados} lembretes enviados via WhatsApp`);
  } catch (err) {
    log(`ERRO lembretes: ${err.message}`);
  }
}

// ============================================
// SCHEDULER PRINCIPAL
// ============================================
let schedulerInterval = null;
let dailyRanAt = null;

export function start() {
  log('Scheduler iniciado');

  // Roda verificações a cada hora
  schedulerInterval = setInterval(async () => {
    const h = now().getHours();
    const today = now().toDateString();

    // Verificações diárias às 8h (só 1x por dia)
    if (h === 8 && dailyRanAt !== today) {
      dailyRanAt = today;
      log('=== Rodando verificações diárias ===');
      await checkPrazosFiscais();
      await checkInadimplencia();
      await sendClientReminders();
    }
  }, 60 * 60 * 1000); // a cada 1h

  // Roda imediatamente se for após 8h e ainda não rodou hoje
  const h = now().getHours();
  if (h >= 8 && dailyRanAt !== now().toDateString()) {
    dailyRanAt = now().toDateString();
    log('Rodando verificações iniciais...');
    checkPrazosFiscais();
    checkInadimplencia();
  }
}

export function stop() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  log('Scheduler parado');
}

// Executar sob demanda
export { checkPrazosFiscais, checkInadimplencia, sendClientReminders };
