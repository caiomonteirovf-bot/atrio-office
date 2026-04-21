// tools/saldanha.js
// Tools do agente Saldanha — varredura de processos de Legalizacao.
// v1 INTERNO: apenas analisa e reporta para equipe. Nao fala com cliente.

import {
  getLegalizations,
  getLegalizationHistorico,
  getLegalizationExigencias,
  addLegalizationHistorico,
} from '../services/gesthub.js';

// === Helpers ===

const MS_DAY = 24 * 60 * 60 * 1000;

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Conta dias uteis (seg-sex) entre duas datas (exclusivo no inicio, inclusivo no fim). */
function diasUteisAte(from, to = new Date()) {
  if (!from) return null;
  const start = new Date(from);
  const end = new Date(to);
  let count = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const d = cur.getDay();
    if (d !== 0 && d !== 6) count++;
  }
  return count;
}

function normStatus(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

function isStatusAtivo(status) {
  const s = normStatus(status);
  return !['CONCLUIDO', 'CANCELADO', 'SEM STATUS', ''].includes(s);
}

/** Status ainda nao iniciados — exclui do sinal "parado" (nao eh anomalia). */
function isStatusNaoIniciado(status) {
  const s = normStatus(status);
  return ['SERVICO A INICIAR', 'SERVICO AINICIAR', 'A INICIAR', 'AGUARDANDO INICIO'].includes(s);
}

const PENDENCIA_KEYWORDS = [
  'FALTA', 'FALTANDO', 'PENDENTE', 'PENDENCIA', 'AGUARDANDO',
  'NAO RECEBI', 'NAO RECEBIDO', 'ENVIAR', 'PRECISO', 'PRECISA',
];

function historicoIndicaPendencia(texto) {
  if (!texto) return false;
  const upper = String(texto).toUpperCase();
  return PENDENCIA_KEYWORDS.some(k => upper.includes(k));
}

// === Sinais ===

/**
 * Sinal 1: Processos parados ha > 7 dias uteis sem movimentacao.
 */
async function detectarParados(legs) {
  const achados = [];
  for (const leg of legs) {
    if (!isStatusAtivo(leg.status)) continue;
    // Status "A iniciar" nao eh anomalia — nao flagar como parado.
    if (isStatusNaoIniciado(leg.status)) continue;

    // Usa updated_at como proxy de ultima movimentacao (historico novo tambem atualiza isso no backend).
    const lastMove = parseDate(leg.updatedAt) || parseDate(leg.createdAt);
    if (!lastMove) continue;

    const dias = diasUteisAte(lastMove);
    if (dias !== null && dias > 7) {
      achados.push({
        _tipo: 'parado',
        id: leg.id,
        cliente: leg.name || '—',
        status: leg.status,
        owner: leg.owner || '—',
        dias,
        motivo: `parado ha ${dias} dias uteis sem movimentacao`,
      });
    }
  }
  return achados;
}

/**
 * Sinal 2: Prazo (expectedDate) em <= 3 dias uteis.
 */
async function detectarPrazoProximo(legs) {
  const achados = [];
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  for (const leg of legs) {
    if (!isStatusAtivo(leg.status)) continue;
    const prazo = parseDate(leg.expectedDate);
    if (!prazo) continue;
    prazo.setHours(0, 0, 0, 0);

    const diasRestantes = diasUteisAte(hoje, prazo);
    // Inclui vencidos (diasRestantes negativo nao existe com diasUteisAte: retorna 0)
    const vencido = prazo < hoje;

    if (vencido || (diasRestantes !== null && diasRestantes <= 3)) {
      achados.push({
        _tipo: 'prazo',
        id: leg.id,
        cliente: leg.name || '—',
        status: leg.status,
        owner: leg.owner || '—',
        prazo: leg.expectedDate,
        vencido,
        diasRestantes: vencido ? -1 : diasRestantes,
        motivo: vencido
          ? `prazo VENCIDO em ${new Date(leg.expectedDate).toLocaleDateString('pt-BR')}`
          : `prazo em ${diasRestantes} dias uteis (${new Date(leg.expectedDate).toLocaleDateString('pt-BR')})`,
      });
    }
  }
  return achados;
}

/**
 * Sinal 3: Ultima entrada de historico contem palavra de pendencia
 * e nao houve follow-up nas ultimas 72h uteis (~3 dias uteis).
 */
async function detectarPendenciaNaoCobrada(legs) {
  const achados = [];

  for (const leg of legs) {
    if (!isStatusAtivo(leg.status)) continue;

    let historico;
    try {
      historico = await getLegalizationHistorico(leg.id);
    } catch {
      continue;
    }
    if (!Array.isArray(historico) || historico.length === 0) continue;

    // Ordena desc por createdAt
    const ordenado = [...historico].sort((a, b) => {
      const da = new Date(a.createdAt).getTime() || 0;
      const db = new Date(b.createdAt).getTime() || 0;
      return db - da;
    });
    const ultima = ordenado[0];
    if (!historicoIndicaPendencia(ultima.texto)) continue;

    const dataUltima = parseDate(ultima.createdAt);
    if (!dataUltima) continue;
    const dias = diasUteisAte(dataUltima);
    if (dias === null || dias < 3) continue; // cobrou faz pouco, deixa quieto

    achados.push({
      _tipo: 'pendencia',
      id: leg.id,
      cliente: leg.name || '—',
      status: leg.status,
      owner: leg.owner || '—',
      dias,
      ultimaMsg: String(ultima.texto).slice(0, 120),
      motivo: `pendencia registrada ha ${dias} dias uteis sem follow-up`,
    });
  }

  return achados;
}

/**
 * Sinal 4: Exigencias com status 'pendente' ha > 5 dias uteis.
 */
async function detectarExigenciasPendentes(legs) {
  const achados = [];

  for (const leg of legs) {
    if (!isStatusAtivo(leg.status)) continue;

    let exigencias;
    try {
      exigencias = await getLegalizationExigencias(leg.id);
    } catch {
      continue;
    }
    if (!Array.isArray(exigencias) || exigencias.length === 0) continue;

    const pendentes = exigencias.filter(e => String(e.status || '').toLowerCase() === 'pendente');
    for (const ex of pendentes) {
      const dataExig = parseDate(ex.dataExigencia) || parseDate(ex.createdAt);
      if (!dataExig) continue;
      const dias = diasUteisAte(dataExig);
      if (dias !== null && dias > 5) {
        achados.push({
          _tipo: 'exigencia',
          id: leg.id,
          cliente: leg.name || '—',
          status: leg.status,
          owner: leg.owner || '—',
          orgao: ex.orgao || '—',
          dias,
          descricao: String(ex.descricao || '').slice(0, 120),
          motivo: `exigencia de ${ex.orgao || 'orgao'} pendente ha ${dias} dias uteis`,
        });
      }
    }
  }

  return achados;
}

// === Classificacao de severidade ===

const CRITICO_PRAZO_DIAS = 15;       // prazo vencido ha mais de N dias uteis
const CRITICO_PENDENCIA_DIAS = 20;   // pendencia sem follow-up ha mais de N dias uteis

function ehCritico(achado) {
  // Prazo vencido ha muito tempo
  if (achado._tipo === 'prazo' && achado.vencido) {
    // Calcula ha quanto tempo venceu (em dias uteis) usando a data do prazo
    const prazoDate = parseDate(achado.prazo);
    if (prazoDate) {
      const diasAtrasado = diasUteisAte(prazoDate);
      if (diasAtrasado !== null && diasAtrasado > CRITICO_PRAZO_DIAS) return true;
    }
  }
  // Pendencia sem follow-up ha muito tempo
  if (achado._tipo === 'pendencia' && achado.dias > CRITICO_PENDENCIA_DIAS) return true;
  return false;
}

// === Formatacao do relatorio ===

function formatBloco(titulo, emoji, itens, linhaFn) {
  if (!itens.length) return '';
  const linhas = itens.slice(0, 10).map(linhaFn).join('\n');
  const extra = itens.length > 10 ? `\n   ... e mais ${itens.length - 10}.` : '';
  return `${emoji} *${titulo} (${itens.length})*\n${linhas}${extra}`;
}

/** Normaliza nome: remove acentos, trim, upper, remove sobrenomes repetidos/typos comuns. */
function normOwner(raw) {
  if (!raw) return '—';
  return String(raw)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().trim()
    .split(/\s+/)[0]; // agrupa pelo primeiro nome — resolve Deyvison/DEYVISON/DEYVISON NORBERTO/DEYVISON NOBERTO
}

function agruparPorOwner(achados) {
  const map = new Map();
  for (const a of achados) {
    const o = normOwner(a.owner);
    if (!map.has(o)) map.set(o, 0);
    map.set(o, map.get(o) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// === Tools exportadas ===

export const tools = {
  /**
   * Varredura completa de Legalizacoes — 4 sinais.
   * Retorna relatorio markdown pronto para postar no chat.
   */
  async saldanha_sweep() {
    try {
      const legs = await getLegalizations();
      if (!Array.isArray(legs)) {
        return { erro: 'Nao foi possivel obter legalizacoes do Gesthub' };
      }

      const ativos = legs.filter(l => isStatusAtivo(l.status));

      const [parados, prazoProximo, pendencias, exigencias] = await Promise.all([
        detectarParados(legs),
        detectarPrazoProximo(legs),
        detectarPendenciaNaoCobrada(legs),
        detectarExigenciasPendentes(legs),
      ]);

      const todos = [...parados, ...prazoProximo, ...pendencias, ...exigencias];
      const criticos = todos.filter(ehCritico);
      const idsCobrar = new Set(todos.map(a => a.id));

      // @mention formatado: pega primeiro nome do owner
      const mention = (owner) => {
        const nome = normOwner(owner);
        return nome === '—' ? '(sem responsavel)' : `@${nome}`;
      };

      const blocos = [
        `⚖️ *Saldanha — varredura de Legalizacao* · ${new Date().toLocaleDateString('pt-BR')}`,
        ``,
        `Processos ativos: *${ativos.length}* · Com sinal de atencao: *${idsCobrar.size}* · *CRITICOS: ${criticos.length}*`,
        ``,
      ];

      // --- BLOCO CRITICO (prioridade maxima, com @mention) ---
      if (criticos.length) {
        blocos.push(`🔥 *CRITICO — acao imediata necessaria*`);
        blocos.push(``);
        const criticosPorOwner = new Map();
        for (const c of criticos) {
          const m = mention(c.owner);
          if (!criticosPorOwner.has(m)) criticosPorOwner.set(m, []);
          criticosPorOwner.get(m).push(c);
        }
        for (const [m, itens] of criticosPorOwner) {
          blocos.push(`${m} — ${itens.length} processo(s):`);
          for (const c of itens.slice(0, 8)) {
            blocos.push(`   • [${c.id}] ${c.cliente} — ${c.motivo}`);
          }
          if (itens.length > 8) blocos.push(`   ... e mais ${itens.length - 8}.`);
        }
        blocos.push(``);
        blocos.push(`─────────────────────`);
        blocos.push(``);
      }

      // --- BLOCO ATENCAO (demais alertas, sem @mention) ---
      const prazoNormais = prazoProximo.filter(a => !ehCritico(a));
      const pendenciasNormais = pendencias.filter(a => !ehCritico(a));

      blocos.push(`📋 *Atencao (nao criticos)*`);
      blocos.push(``);
      blocos.push(formatBloco(
        'Prazos em 3 dias ou vencidos',
        '🚨',
        prazoNormais.sort((a, b) => (a.diasRestantes ?? 99) - (b.diasRestantes ?? 99)),
        a => `   • [${a.id}] ${a.cliente} — ${a.motivo} · resp: ${a.owner}`,
      ));
      blocos.push(formatBloco(
        'Exigencias de orgao nao resolvidas',
        '📋',
        exigencias.sort((a, b) => b.dias - a.dias),
        a => `   • [${a.id}] ${a.cliente} — ${a.motivo}${a.descricao ? ` — ${a.descricao}` : ''} · resp: ${a.owner}`,
      ));
      blocos.push(formatBloco(
        'Pendencias sem follow-up',
        '📨',
        pendenciasNormais.sort((a, b) => b.dias - a.dias),
        a => `   • [${a.id}] ${a.cliente} — ${a.motivo} · "${a.ultimaMsg}" · resp: ${a.owner}`,
      ));
      blocos.push(formatBloco(
        'Processos parados > 7 dias uteis',
        '⏸️',
        parados.sort((a, b) => b.dias - a.dias),
        a => `   • [${a.id}] ${a.cliente} — ${a.motivo} · status: ${a.status} · resp: ${a.owner}`,
      ));

      // Resumo por responsavel
      const porOwner = agruparPorOwner(todos);
      if (porOwner.length) {
        blocos.push('');
        blocos.push('👥 *Distribuicao por responsavel:*');
        porOwner.forEach(([owner, count]) => blocos.push(`   • ${owner}: ${count} alerta(s)`));
      }

      if (idsCobrar.size === 0) {
        blocos.push('');
        blocos.push('✓ Nenhum sinal de atencao. Legalizacao em dia.');
      }

      return {
        texto: blocos.join('\n'),
        totais: {
          ativos: ativos.length,
          com_alerta: idsCobrar.size,
          criticos: criticos.length,
          parados: parados.length,
          prazo_proximo: prazoProximo.length,
          pendencias_sem_followup: pendencias.length,
          exigencias_pendentes: exigencias.length,
        },
      };
    } catch (e) {
      console.error('[Saldanha] sweep erro:', e.message);
      return { erro: e.message, texto: `⚠️ Saldanha: falha na varredura — ${e.message}` };
    }
  },

  /**
   * Lista legalizacoes com filtros opcionais.
   * Uso tipico: "quantos ativos temos?", "quais estao em andamento?"
   */
  async saldanha_listar_legalizacoes({ status = null, owner = null, apenas_ativos = true, limit = 30 } = {}) {
    try {
      const legs = await getLegalizations();
      if (!Array.isArray(legs)) return { erro: 'Nao foi possivel obter legalizacoes' };

      let filtrados = legs;
      if (apenas_ativos) filtrados = filtrados.filter(l => isStatusAtivo(l.status));
      if (status) filtrados = filtrados.filter(l => normStatus(l.status) === normStatus(status));
      if (owner) {
        const target = normOwner(owner);
        filtrados = filtrados.filter(l => normOwner(l.owner) === target);
      }

      const resumo = {
        total: filtrados.length,
        processos: filtrados.slice(0, limit).map(l => ({
          id: l.id,
          cliente: l.name || '—',
          documento: l.document || null,
          tipo_processo: l.processType || null,
          status: l.status,
          responsavel: l.owner || null,
          prazo: l.expectedDate || null,
          data_abertura: l.openDate || null,
        })),
      };

      if (filtrados.length > limit) resumo.truncado = `mostrando ${limit} de ${filtrados.length}`;

      // Quebra tambem por status para contexto agregado
      const porStatus = {};
      for (const l of filtrados) {
        const s = l.status || 'SEM STATUS';
        porStatus[s] = (porStatus[s] || 0) + 1;
      }
      resumo.por_status = porStatus;

      return resumo;
    } catch (e) {
      return { erro: e.message };
    }
  },

  /**
   * Busca um processo especifico por id ou termo (nome do cliente, CNPJ).
   * Retorna detalhe completo com historico e exigencias.
   */
  async saldanha_buscar_processo({ id = null, termo = null }) {
    try {
      if (!id && !termo) return { erro: 'Informe id ou termo de busca' };

      const legs = await getLegalizations();
      if (!Array.isArray(legs)) return { erro: 'Nao foi possivel obter legalizacoes' };

      let leg = null;
      if (id) {
        leg = legs.find(l => String(l.id) === String(id));
      } else {
        const t = String(termo).toLowerCase().trim();
        const tDigits = t.replace(/\D/g, '');
        const candidatos = legs.filter(l => {
          const nome = (l.name || '').toLowerCase();
          const doc = (l.document || '').replace(/\D/g, '');
          return nome.includes(t) || (tDigits && doc.includes(tDigits));
        });
        if (candidatos.length === 0) return { erro: 'Nenhum processo encontrado para: ' + termo };
        if (candidatos.length > 1) {
          return {
            multiplos: candidatos.slice(0, 10).map(l => ({
              id: l.id, cliente: l.name, status: l.status, responsavel: l.owner,
            })),
            total: candidatos.length,
            dica: 'Multiplos resultados. Informe o id do processo desejado.',
          };
        }
        leg = candidatos[0];
      }

      if (!leg) return { erro: 'Processo nao encontrado' };

      // Busca historico e exigencias em paralelo
      const [historico, exigencias] = await Promise.all([
        getLegalizationHistorico(leg.id).catch(() => []),
        getLegalizationExigencias(leg.id).catch(() => []),
      ]);

      return {
        processo: {
          id: leg.id,
          cliente: leg.name,
          documento: leg.document,
          tipo_processo: leg.processType,
          orgao: leg.organ,
          protocolo: leg.protocol,
          status: leg.status,
          responsavel: leg.owner,
          parceiro: leg.partner,
          prazo: leg.expectedDate,
          data_abertura: leg.openDate,
          pendencias: leg.pendencies,
          documentos: leg.documents,
          observacoes: leg.notes,
          honorario: leg.honorarium,
        },
        historico: (historico || []).slice(0, 10).map(h => ({
          data: h.createdAt,
          autor: h.autor,
          texto: h.texto,
        })),
        exigencias: (exigencias || []).map(e => ({
          orgao: e.orgao,
          descricao: e.descricao,
          status: e.status,
          data: e.dataExigencia,
          resolucao: e.resolucao,
        })),
      };
    } catch (e) {
      return { erro: e.message };
    }
  },

  /**
   * Registra entrada no historico de um processo (autor = Saldanha).
   * Util quando a varredura quiser deixar um "ping" no processo.
   */
  async saldanha_registrar_historico({ legalization_id, texto }) {
    if (!legalization_id || !texto) {
      return { erro: 'Parametros legalization_id e texto sao obrigatorios' };
    }
    try {
      const entry = await addLegalizationHistorico(legalization_id, { texto, autor: 'Saldanha' });
      return { ok: true, entry };
    } catch (e) {
      return { erro: e.message };
    }
  },
};
