// Datalake viewer — endpoints de leitura (cliente_360 + contatos + conversas)
import { query } from '../db/pool.js';

export function registerDatalake(app) {
  // Lista de clientes com filtros
  app.get('/api/datalake/clientes', async (req, res) => {
    try {
      const { q = '', analyst, regime, status, sem_luna, limit = '200' } = req.query;
      const where = [];
      const params = [];
      let i = 1;
      if (q) {
        where.push(`(razao_social ILIKE '%'||$${i}||'%' OR nome_fantasia ILIKE '%'||$${i}||'%' OR regexp_replace(cnpj,'\D','','g') LIKE '%'||regexp_replace($${i},'\D','','g')||'%' OR socio_responsavel ILIKE '%'||$${i}||'%')`);
        params.push(q); i++;
      }
      if (analyst) { where.push(`analyst = $${i}`); params.push(analyst); i++; }
      if (regime)  { where.push(`regime = $${i}`);  params.push(regime);  i++; }
      if (status)  { where.push(`status_gesthub = $${i}`); params.push(status); i++; }
      if (sem_luna === 'true') where.push('luna_client_id IS NULL');

      const sql = `SELECT gesthub_id, cnpj, razao_social, nome_fantasia, regime, status_gesthub, optante_simples, fator_r, porte, qtd_contatos, qtd_socios, nfse_emitidas, nfse_ultima_emissao,
                          mensalidade, socio_responsavel, analyst, city, state, headcount,
                          contas_bancarias, memorias_ativas, conversas_whatsapp, luna_client_id
                   FROM datalake.cliente_360
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY mensalidade DESC NULLS LAST, razao_social
                   LIMIT $${i}`;
      params.push(Math.min(500, parseInt(limit) || 200));
      const r = await query(sql, params);
      res.json({ total: r.rowCount, rows: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Detalhe completo de 1 cliente
  app.get('/api/datalake/cliente/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'id invalido' });

      const [c360, contatos, socios] = await Promise.all([
        query(`SELECT * FROM datalake.cliente_360 WHERE gesthub_id = $1`, [id]),
        query(`SELECT id, nome, funcao, telefone, email, cpf FROM datalake_gesthub.cliente_contatos WHERE cliente_id = $1 ORDER BY funcao, nome`, [id]),
        query(`SELECT nome, cpf_cnpj, email, telefone, qualificacao, participacao FROM datalake_gesthub.socios WHERE cliente_id =  AND ativo = true ORDER BY participacao DESC NULLS LAST$1`, [id]).catch(() => ({ rows: [] })),
      ]);

      const cliente = c360.rows[0];
      if (!cliente) return res.status(404).json({ error: 'cliente nao encontrado' });

      // --- NFS-e: match por gesthub_id OU CNPJ prestador (registros orfaos) ---
      let nfses = [];
      try {
        const cnpjDigits = (cliente.cnpj || '').replace(/\D/g, '');
        const nfseRes = await query(`
          SELECT id, numero, serie, codigo_verificacao, data_emissao, competencia, status,
                 tomador_razao_social, tomador_cpf_cnpj, descricao_servico, valor_servicos,
                 valor_deducoes, valor_liquido, aliquota_iss, valor_iss, item_lista_servico,
                 codigo_cnae, link_url, cliente_gesthub_id, prestador_cnpj, created_at
          FROM datalake_nfse.nfses
          WHERE cliente_gesthub_id = $1
             OR ($2 <> '' AND regexp_replace(prestador_cnpj, '\\D', '', 'g') = $2)
          ORDER BY data_emissao DESC NULLS LAST, id DESC
          LIMIT 100
        `, [id, cnpjDigits]);
        nfses = nfseRes.rows;
      } catch (e) {
        console.warn('[datalake/cliente] nfse query falhou:', e.message);
      }

      // Agregados NFS-e pra sumario rapido
      const nfseStats = {
        total: nfses.length,
        mesAtual: 0, mesAnterior: 0,
        valorMesAtual: 0, valorMesAnterior: 0, valor12m: 0,
        ultimaEmissao: null,
      };
      const hoje = new Date();
      const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      const inicioMesAnt = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
      const inicio12m = new Date(hoje.getFullYear() - 1, hoje.getMonth(), 1);
      for (const n of nfses) {
        const d = n.data_emissao ? new Date(n.data_emissao) : null;
        if (!d) continue;
        if (!nfseStats.ultimaEmissao || d > new Date(nfseStats.ultimaEmissao)) nfseStats.ultimaEmissao = n.data_emissao;
        const valor = Number(n.valor_servicos || 0);
        if (d >= inicioMes) { nfseStats.mesAtual++; nfseStats.valorMesAtual += valor; }
        else if (d >= inicioMesAnt) { nfseStats.mesAnterior++; nfseStats.valorMesAnterior += valor; }
        if (d >= inicio12m) nfseStats.valor12m += valor;
      }

      // Conversas Luna + memorias (se vinculado)
      let conversas = [], memorias = [];
      if (cliente.luna_client_id) {
        const [conv, mem] = await Promise.all([
          query(`SELECT id, phone, attendance_status, last_inbound_at, last_outbound_at, last_human_reply_at, mensagens_count, started_at FROM luna_v2.conversations WHERE client_id = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 20`, [cliente.luna_client_id]).catch(() => ({ rows: [] })),
          query(`SELECT id, tipo, titulo, conteudo, prioridade, created_at FROM luna_v2.memories WHERE client_id = $1 AND status='ativa' ORDER BY prioridade DESC, created_at DESC LIMIT 50`, [cliente.luna_client_id]).catch(() => ({ rows: [] })),
        ]);
        conversas = conv.rows; memorias = mem.rows;
      }

      // --- Atrio Finance: contas bancarias + uploads de extrato + agregado de conciliacao ---
      let financeContas = [];
      let financeExtratos = [];
      let financeStats = {
        contasAtivas: 0,
        contasTotal: 0,
        extratosPendentes: 0,
        extratosConciliados12m: 0,
        ultimaCompetenciaConciliada: null,
        transacoes30d: 0,
        entradas30d: 0,
        saidas30d: 0,
      };
      try {
        const [contasR, extratosR, stats30dR] = await Promise.all([
          query(`
            SELECT id, banco, banco_codigo, agencia, conta, tipo, descricao, ativo, created_at, updated_at
            FROM datalake_banking.contas_bancarias
            WHERE cliente_gesthub_id = $1
            ORDER BY ativo DESC, banco
          `, [id]).catch(() => ({ rows: [] })),
          query(`
            SELECT u.id, u.filename, u.file_type, u.status, u.periodo_inicio, u.periodo_fim,
                   u.competencia, u.transacoes_count, u.observacoes, u.created_at,
                   c.banco, c.conta
            FROM datalake_banking.uploads_extrato u
            LEFT JOIN datalake_banking.contas_bancarias c ON c.id = u.conta_id
            WHERE u.cliente_gesthub_id = $1
            ORDER BY u.competencia DESC NULLS LAST, u.created_at DESC
            LIMIT 24
          `, [id]).catch(() => ({ rows: [] })),
          query(`
            SELECT
              count(*)::int AS total,
              COALESCE(sum(CASE WHEN valor > 0 THEN valor ELSE 0 END), 0)::numeric AS entradas,
              COALESCE(sum(CASE WHEN valor < 0 THEN valor ELSE 0 END), 0)::numeric AS saidas
            FROM datalake_banking.transacoes
            WHERE cliente_gesthub_id = $1 AND data >= CURRENT_DATE - INTERVAL '30 days'
          `, [id]).catch(() => ({ rows: [{ total: 0, entradas: 0, saidas: 0 }] })),
        ]);
        financeContas = contasR.rows;
        financeExtratos = extratosR.rows;

        financeStats.contasAtivas = financeContas.filter(c => c.ativo).length;
        financeStats.contasTotal = financeContas.length;

        const pendStatuses = new Set(['pendente', 'em_processamento', 'erro']);
        for (const e of financeExtratos) {
          if (pendStatuses.has(String(e.status || '').toLowerCase())) financeStats.extratosPendentes++;
          if (String(e.status || '').toLowerCase() === 'conciliado' && e.competencia) {
            financeStats.extratosConciliados12m++;
            const compDate = new Date(e.competencia);
            if (!financeStats.ultimaCompetenciaConciliada || compDate > new Date(financeStats.ultimaCompetenciaConciliada)) {
              financeStats.ultimaCompetenciaConciliada = e.competencia;
            }
          }
        }

        const s30 = stats30dR.rows[0] || {};
        financeStats.transacoes30d = Number(s30.total || 0);
        financeStats.entradas30d = Number(s30.entradas || 0);
        financeStats.saidas30d = Number(s30.saidas || 0);
      } catch (e) {
        console.warn('[datalake/cliente] finance query falhou:', e.message);
      }

      res.json({
        cliente,
        contatos: contatos.rows,
        socios: socios.rows,
        conversas,
        memorias,
        nfses,
        nfseStats,
        finance: {
          contas: financeContas,
          extratos: financeExtratos,
          stats: financeStats,
        },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Facetas pra filtros
  app.get('/api/datalake/facets', async (req, res) => {
    try {
      const r = await query(`
        SELECT 'analyst' AS tipo, analyst AS valor, count(*)::int AS n FROM datalake.cliente_360 WHERE analyst IS NOT NULL GROUP BY analyst
        UNION ALL
        SELECT 'regime', regime, count(*)::int FROM datalake.cliente_360 WHERE regime IS NOT NULL GROUP BY regime
        UNION ALL
        SELECT 'status', status_gesthub, count(*)::int FROM datalake.cliente_360 WHERE status_gesthub IS NOT NULL GROUP BY status_gesthub
        ORDER BY tipo, n DESC`);
      const out = { analyst: [], regime: [], status: [] };
      for (const row of r.rows) out[row.tipo]?.push({ valor: row.valor, n: row.n });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Badges agregados por cliente_gesthub_id — usado pela Carteira do Gesthub
  // pra mostrar indicadores visuais de presenca em cada sub-sistema.
  // Retorno: { "66": { finance: {...}, nfse: {...} }, "27": {...}, ... }
  app.get('/api/datalake/badges', async (req, res) => {
    try {
      const r = await query(`
        WITH fin AS (
          SELECT cliente_gesthub_id AS cid,
                 COUNT(*)::int AS transacoes,
                 MAX(data) AS ultima_data,
                 SUM(CASE WHEN tipo='CREDIT' OR valor > 0 THEN valor ELSE 0 END)::float AS creditos,
                 SUM(CASE WHEN tipo='DEBIT' OR valor < 0 THEN ABS(valor) ELSE 0 END)::float AS debitos
            FROM datalake_banking.transacoes
           WHERE cliente_gesthub_id IS NOT NULL
           GROUP BY cliente_gesthub_id
        ),
        uploads AS (
          SELECT cliente_gesthub_id AS cid,
                 COUNT(*)::int AS extratos,
                 MAX(COALESCE(competencia, created_at::date)) AS ultimo_extrato
            FROM datalake_banking.uploads_extrato
           WHERE cliente_gesthub_id IS NOT NULL
           GROUP BY cliente_gesthub_id
        ),
        nfs AS (
          SELECT c.id AS cid,
                 COUNT(n.*)::int AS total_nfse,
                 COUNT(n.*) FILTER (WHERE n.status='EMITIDA')::int AS emitidas,
                 COUNT(n.*) FILTER (WHERE n.status IN ('PENDENTE','RASCUNHO','ERRO'))::int AS pendentes,
                 MAX(n.data_emissao) AS ultima_emissao,
                 SUM(CASE WHEN n.status='EMITIDA' THEN n.valor_servicos ELSE 0 END)::float AS valor_total
            FROM datalake_nfse.nfses n
            JOIN datalake_gesthub.clients c
              ON regexp_replace(COALESCE(c.document,''),'\\D','','g') = regexp_replace(COALESCE(n.prestador_cnpj,''),'\\D','','g')
           WHERE COALESCE(n.prestador_cnpj,'') <> ''
           GROUP BY c.id
        )
        SELECT COALESCE(fin.cid, uploads.cid, nfs.cid) AS cliente_id,
               fin.transacoes, fin.ultima_data, fin.creditos, fin.debitos,
               uploads.extratos, uploads.ultimo_extrato,
               nfs.total_nfse, nfs.emitidas, nfs.pendentes, nfs.ultima_emissao, nfs.valor_total
          FROM fin
          FULL OUTER JOIN uploads ON fin.cid = uploads.cid
          FULL OUTER JOIN nfs     ON COALESCE(fin.cid, uploads.cid) = nfs.cid
      `);

      const badges = {};
      for (const row of r.rows) {
        const cid = row.cliente_id;
        if (!cid) continue;
        const finance = (row.transacoes || row.extratos) ? {
          transacoes: row.transacoes || 0,
          extratos: row.extratos || 0,
          ultimaData: row.ultima_data || row.ultimo_extrato || null,
          creditos: Number(row.creditos || 0),
          debitos: Number(row.debitos || 0),
        } : null;
        const nfse = row.total_nfse ? {
          total: row.total_nfse,
          emitidas: row.emitidas || 0,
          pendentes: row.pendentes || 0,
          ultimaEmissao: row.ultima_emissao || null,
          valorTotal: Number(row.valor_total || 0),
        } : null;
        if (finance || nfse) {
          badges[String(cid)] = { finance, nfse };
        }
      }

      res.json({
        ok: true,
        data: badges,
        stats: {
          clientesComDados: Object.keys(badges).length,
          comFinance: Object.values(badges).filter(b => b.finance).length,
          comNfse: Object.values(badges).filter(b => b.nfse).length,
        },
      });
    } catch (e) {
      console.error('[datalake/badges]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Ecossistema — dashboard cross-system
  // Agrega cobertura (% clientes ativos com dados em cada sub-sistema),
  // atividade recente (uploads/emissoes), e gaps (clientes ativos sem dados).
  app.get('/api/datalake/ecossistema', async (req, res) => {
    try {
      const [
        kpisR,
        coberturaR,
        atividadeR,
        gapsR,
        topR,
      ] = await Promise.all([
        // 1. KPIs globais
        query(`
          SELECT
            (SELECT COUNT(*) FROM datalake.cliente_360 WHERE status_gesthub='ATIVO')::int AS ativos,
            (SELECT COUNT(*) FROM datalake.cliente_360)::int AS total_clientes,
            (SELECT COUNT(*) FROM datalake.cliente_360 WHERE luna_client_id IS NOT NULL)::int AS com_luna,
            (SELECT COUNT(DISTINCT cliente_gesthub_id) FROM datalake_banking.transacoes WHERE cliente_gesthub_id IS NOT NULL)::int AS com_finance,
            (SELECT COUNT(DISTINCT c.id) FROM datalake_nfse.nfses n
               JOIN datalake_gesthub.clients c
                 ON regexp_replace(COALESCE(c.document,''),'\\D','','g') = regexp_replace(COALESCE(n.prestador_cnpj,''),'\\D','','g')
              WHERE COALESCE(n.prestador_cnpj,'')<>'')::int AS com_nfse,
            (SELECT COUNT(*) FROM datalake_banking.uploads_extrato)::int AS total_uploads,
            (SELECT COUNT(*) FROM datalake_banking.transacoes)::int AS total_transacoes,
            (SELECT COUNT(*) FROM datalake_nfse.nfses)::int AS total_nfse,
            (SELECT COUNT(*) FROM datalake_nfse.nfses WHERE status='EMITIDA')::int AS nfse_emitidas,
            (SELECT COUNT(*) FROM datalake_nfse.nfses WHERE status IN ('PENDENTE','RASCUNHO','ERRO'))::int AS nfse_pendentes,
            (SELECT COALESCE(SUM(valor_servicos),0) FROM datalake_nfse.nfses WHERE status='EMITIDA')::float AS nfse_valor_total,
            (SELECT COALESCE(SUM(CASE WHEN tipo='CREDIT' OR valor>0 THEN valor ELSE 0 END),0) FROM datalake_banking.transacoes)::float AS finance_creditos,
            (SELECT COALESCE(SUM(CASE WHEN tipo='DEBIT' OR valor<0 THEN ABS(valor) ELSE 0 END),0) FROM datalake_banking.transacoes)::float AS finance_debitos
        `),

        // 2. Cobertura detalhada por cliente ativo
        query(`
          WITH ativos AS (
            SELECT id, legal_name, trade_name, document
              FROM datalake_gesthub.clients WHERE UPPER(status)='ATIVO'
          ),
          fin AS (
            SELECT cliente_gesthub_id AS cid, COUNT(*)::int AS tx
              FROM datalake_banking.transacoes
             WHERE cliente_gesthub_id IS NOT NULL GROUP BY cliente_gesthub_id
          ),
          nfs AS (
            SELECT c.id AS cid, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE n.status='EMITIDA')::int AS emitidas
              FROM datalake_nfse.nfses n
              JOIN datalake_gesthub.clients c
                ON regexp_replace(COALESCE(c.document,''),'\\D','','g') = regexp_replace(COALESCE(n.prestador_cnpj,''),'\\D','','g')
             WHERE COALESCE(n.prestador_cnpj,'')<>''
             GROUP BY c.id
          )
          SELECT
            a.id,
            a.legal_name,
            a.trade_name,
            (fin.tx > 0) AS tem_finance,
            COALESCE(fin.tx, 0) AS finance_tx,
            (nfs.total > 0) AS tem_nfse,
            COALESCE(nfs.emitidas, 0) AS nfse_emitidas,
            ((fin.tx > 0)::int + (nfs.total > 0)::int) AS score
            FROM ativos a
            LEFT JOIN fin ON fin.cid = a.id
            LEFT JOIN nfs ON nfs.cid = a.id
        `),

        // 3. Atividade recente cross-sistema (uploads + nfse + learnings recentes)
        query(`
          (SELECT 'upload'::text AS tipo,
                  u.created_at AS data,
                  c.legal_name AS cliente_nome,
                  c.id AS cliente_id,
                  u.filename AS titulo,
                  u.transacoes_count AS valor,
                  u.competencia::text AS extra
             FROM datalake_banking.uploads_extrato u
             LEFT JOIN datalake_gesthub.clients c ON c.id = u.cliente_gesthub_id
             ORDER BY u.created_at DESC NULLS LAST
             LIMIT 10)
          UNION ALL
          (SELECT 'nfse'::text AS tipo,
                  n.data_emissao::timestamp AS data,
                  COALESCE(c.legal_name, n.prestador_razao_social) AS cliente_nome,
                  c.id AS cliente_id,
                  ('NFS-e ' || COALESCE(n.numero,'--') || ' ' || COALESCE(n.tomador_razao_social,''))::text AS titulo,
                  n.valor_servicos AS valor,
                  n.status AS extra
             FROM datalake_nfse.nfses n
             LEFT JOIN datalake_gesthub.clients c
               ON regexp_replace(COALESCE(c.document,''),'\\D','','g') = regexp_replace(COALESCE(n.prestador_cnpj,''),'\\D','','g')
             ORDER BY n.data_emissao DESC NULLS LAST
             LIMIT 10)
          ORDER BY data DESC NULLS LAST
          LIMIT 15
        `),

        // 4. Gaps: clientes ativos SEM nenhum dado em Finance/NFSe/Luna
        query(`
          WITH ativos AS (
            SELECT c.id, c.legal_name, c.trade_name, c.document, c360.luna_client_id
              FROM datalake_gesthub.clients c
              LEFT JOIN datalake.cliente_360 c360 ON c360.gesthub_id = c.id
             WHERE UPPER(c.status)='ATIVO'
          ),
          fin AS (SELECT DISTINCT cliente_gesthub_id AS cid FROM datalake_banking.transacoes WHERE cliente_gesthub_id IS NOT NULL),
          nfs AS (
            SELECT DISTINCT c.id AS cid
              FROM datalake_nfse.nfses n
              JOIN datalake_gesthub.clients c
                ON regexp_replace(COALESCE(c.document,''),'\\D','','g') = regexp_replace(COALESCE(n.prestador_cnpj,''),'\\D','','g')
             WHERE COALESCE(n.prestador_cnpj,'')<>''
          )
          SELECT a.id, a.legal_name, a.trade_name, a.document
            FROM ativos a
            LEFT JOIN fin ON fin.cid = a.id
            LEFT JOIN nfs ON nfs.cid = a.id
           WHERE fin.cid IS NULL AND nfs.cid IS NULL AND a.luna_client_id IS NULL
           ORDER BY a.legal_name
           LIMIT 50
        `),

        // 5. Top clientes por riqueza de dados (mais sistemas cobrindo)
        query(`
          WITH fin AS (
            SELECT cliente_gesthub_id AS cid, COUNT(*)::int AS tx, SUM(ABS(valor))::float AS volume
              FROM datalake_banking.transacoes WHERE cliente_gesthub_id IS NOT NULL GROUP BY cliente_gesthub_id
          ),
          nfs AS (
            SELECT c.id AS cid, COUNT(*)::int AS total
              FROM datalake_nfse.nfses n
              JOIN datalake_gesthub.clients c
                ON regexp_replace(COALESCE(c.document,''),'\\D','','g') = regexp_replace(COALESCE(n.prestador_cnpj,''),'\\D','','g')
             WHERE COALESCE(n.prestador_cnpj,'')<>'' GROUP BY c.id
          )
          SELECT c.id, c.legal_name, c.trade_name,
                 COALESCE(fin.tx, 0) AS finance_tx,
                 COALESCE(fin.volume, 0) AS finance_volume,
                 COALESCE(nfs.total, 0) AS nfse_total,
                 ((COALESCE(fin.tx, 0) > 0)::int + (COALESCE(nfs.total, 0) > 0)::int + (c360.luna_client_id IS NOT NULL)::int)::int AS sistemas
            FROM datalake_gesthub.clients c
            LEFT JOIN datalake.cliente_360 c360 ON c360.gesthub_id = c.id
            LEFT JOIN fin ON fin.cid = c.id
            LEFT JOIN nfs ON nfs.cid = c.id
           WHERE UPPER(c.status)='ATIVO' AND (fin.cid IS NOT NULL OR nfs.cid IS NOT NULL)
           ORDER BY sistemas DESC, COALESCE(fin.tx, 0) DESC, COALESCE(nfs.total, 0) DESC
           LIMIT 10
        `),
      ]);

      const k = kpisR.rows[0];
      const ativos = k.ativos || 1;  // evita divisao por zero

      // Agrupa cobertura
      const comSistemas = {
        zero: 0, um: 0, dois: 0, tres: 0,
      };
      for (const row of coberturaR.rows) {
        const hasLuna = false; // nao carregado por row — ok, score basico
        const score = (row.tem_finance ? 1 : 0) + (row.tem_nfse ? 1 : 0);
        if (score === 0) comSistemas.zero++;
        else if (score === 1) comSistemas.um++;
        else if (score === 2) comSistemas.dois++;
        else comSistemas.tres++;
      }

      // Fornecedores: buscar do Gesthub (nao temos FDW)
      let fornecedoresStats = null;
      try {
        const gesthubUrl = process.env.GESTHUB_API_URL || 'http://31.97.175.200';
        const resp = await fetch(`${gesthubUrl}/api/datalake/badges`);
        if (resp.ok) {
          const payload = await resp.json();
          const data = payload.data || {};
          const comFornecedores = Object.values(data).filter(v => v.fornecedores).length;
          const totalFornecedores = Object.values(data).reduce((s, v) => s + (v.fornecedores?.total || 0), 0);
          fornecedoresStats = { clientes: comFornecedores, total: totalFornecedores };
        }
      } catch (e) { console.warn('[ecossistema] fornecedores fetch:', e.message); }

      // Learnings stats via Gesthub
      let learningsStats = null;
      try {
        const gesthubUrl = process.env.GESTHUB_API_URL || 'http://31.97.175.200';
        const resp = await fetch(`${gesthubUrl}/api/learnings/stats`);
        if (resp.ok) {
          const payload = await resp.json();
          learningsStats = payload.data || null;
        }
      } catch (e) { console.warn('[ecossistema] learnings fetch:', e.message); }

      // Sanity status (ultimo sweep; preview sob demanda se nunca rodou)
      let sanityStatus = null;
      try {
        const gesthubUrl = process.env.GESTHUB_API_URL || 'http://31.97.175.200';
        let resp = await fetch(`${gesthubUrl}/api/sanity/status`);
        let payload = resp.ok ? await resp.json() : null;
        if (payload && !payload.data) {
          // Nunca rodou desde o boot — roda preview pra pegar um snapshot
          resp = await fetch(`${gesthubUrl}/api/sanity/preview`);
          if (resp.ok) payload = await resp.json();
        }
        if (payload?.data) {
          sanityStatus = {
            totais: payload.data.totais,
            duplicados: payload.data.contatosDuplicados?.length || 0,
            docsInvalidos: payload.data.documentosInvalidos?.length || 0,
            cpfsInvalidos: payload.data.cpfsInvalidosContato?.length || 0,
            correcoesAplicadas: payload.data.totais?.correcoesAplicadas || 0,
            issuesParaRevisar: payload.data.totais?.issuesParaRevisar || 0,
            // Listas completas pra UI expandir e deep-link pra resolver no Gesthub
            documentosInvalidosList: payload.data.documentosInvalidos || [],
            contatosDuplicadosList: payload.data.contatosDuplicados || [],
            cpfsInvalidosList: payload.data.cpfsInvalidosContato || [],
            ranAt: payload.ranAt,
            mode: payload.mode,
          };
        }
      } catch (e) { console.warn('[ecossistema] sanity fetch:', e.message); }

      // Tasks bloqueadas (visibilidade ativa — evita "avisou mas ninguem viu")
      let tasksBloqueadas = null;
      try {
        const { rows } = await query(`
          SELECT
            t.id, t.title, t.created_at, t.updated_at, t.priority,
            tm.name AS assigned_name,
            t.result->>'error' AS erro,
            COALESCE(jsonb_array_length(t.result->'tool_failures'), 0) AS tool_failures_count,
            EXTRACT(EPOCH FROM (NOW() - t.updated_at))::int AS segundos_bloqueada
          FROM tasks t
          LEFT JOIN team_members tm ON t.assigned_to = tm.id
          WHERE t.status = 'blocked'
          ORDER BY t.updated_at DESC
          LIMIT 20
        `);
        // Agrupa por tipo de erro (loop, api externa, dados, etc)
        const porTipo = { loop: 0, api_externa: 0, dados_invalidos: 0, tool_falhou: 0, outros: 0 };
        for (const r of rows) {
          const e = (r.erro || '').toLowerCase();
          if (/loop.*ferramentas|excedeu.*rounds/i.test(e)) porTipo.loop++;
          else if (/fetch|econnrefused|timeout/i.test(e)) porTipo.api_externa++;
          else if (/cnpj|cpf|invalid/i.test(e)) porTipo.dados_invalidos++;
          else if (/tool|emitir_nfse/i.test(e)) porTipo.tool_falhou++;
          else porTipo.outros++;
        }
        tasksBloqueadas = {
          total: rows.length,
          porTipo,
          recentes: rows.slice(0, 10),
        };
      } catch (e) { console.warn('[ecossistema] tasks bloqueadas:', e.message); }

      res.json({
        ok: true,
        data: {
          kpis: {
            ativos: k.ativos,
            totalClientes: k.total_clientes,
            comFinance: k.com_finance,
            comNfse: k.com_nfse,
            comLuna: k.com_luna,
            comFornecedores: fornecedoresStats?.clientes ?? null,
            totalUploads: k.total_uploads,
            totalTransacoes: k.total_transacoes,
            totalNfse: k.total_nfse,
            nfseEmitidas: k.nfse_emitidas,
            nfsePendentes: k.nfse_pendentes,
            nfseValorTotal: Number(k.nfse_valor_total || 0),
            financeCreditos: Number(k.finance_creditos || 0),
            financeDebitos: Number(k.finance_debitos || 0),
            totalFornecedores: fornecedoresStats?.total ?? null,
          },
          cobertura: {
            finance: { count: k.com_finance, percent: Math.round((k.com_finance / ativos) * 100) },
            nfse:    { count: k.com_nfse,    percent: Math.round((k.com_nfse / ativos) * 100) },
            luna:    { count: k.com_luna,    percent: Math.round((k.com_luna / ativos) * 100) },
            fornecedores: fornecedoresStats ? {
              count: fornecedoresStats.clientes,
              percent: Math.round((fornecedoresStats.clientes / ativos) * 100),
            } : null,
          },
          distribuicaoPorSistemas: comSistemas,
          atividadeRecente: atividadeR.rows,
          gaps: {
            ativosSemDados: gapsR.rows,
            count: gapsR.rows.length,
          },
          topClientes: topR.rows,
          learnings: learningsStats,
          sanity: sanityStatus,
          tasksBloqueadas,
        },
      });
    } catch (e) {
      console.error('[datalake/ecossistema]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Proxy pro sanity/run do Gesthub (botao "Rodar sweep" no dashboard)
  app.post('/api/datalake/sanity-run', async (req, res) => {
    try {
      const gesthubUrl = process.env.GESTHUB_API_URL || 'http://31.97.175.200';
      const r = await fetch(`${gesthubUrl}/api/sanity/run`, { method: 'POST' });
      const j = await r.json();
      res.status(r.status).json(j);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Resumo/stats
  app.get('/api/datalake/summary', async (req, res) => {
    try {
      const r = await query(`SELECT count(*)::int AS total,
                                     count(*) FILTER (WHERE status_gesthub='ATIVO')::int AS ativos,
                                     count(*) FILTER (WHERE luna_client_id IS NOT NULL)::int AS com_luna,
                                     count(*) FILTER (WHERE luna_client_id IS NULL AND status_gesthub='ATIVO')::int AS sem_luna,
                                     COALESCE(sum(mensalidade),0)::numeric AS receita_mensal
                              FROM datalake.cliente_360`);
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
