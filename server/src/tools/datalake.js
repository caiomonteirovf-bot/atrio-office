// Tool compartilhada: consulta ao datalake (cliente 360)
import { query } from '../db/pool.js';

export async function consultarDatalake(args = {}) {
  const tipo = String(args.tipo || '').toLowerCase();
  const filtro = String(args.filtro || '').trim();
  const limite = Math.min(50, Math.max(1, parseInt(args.limite) || 10));
  try {
    let sql, params;
    switch (tipo) {
      case 'cliente_por_cnpj': {
        const cnpjLimpo = filtro.replace(/\D/g, '');
        if (!cnpjLimpo) return { erro: 'filtro CNPJ obrigatorio' };
        sql = `SELECT cnpj, razao_social, nome_fantasia, regime, status_gesthub,
                      mensalidade, socio_responsavel, analyst, city, state,
                      headcount, contas_bancarias, memorias_ativas, conversas_whatsapp
               FROM datalake.cliente_360
               WHERE regexp_replace(cnpj, '\\D', '', 'g') = $1 LIMIT 1`;
        params = [cnpjLimpo];
        break;
      }
      case 'cliente_por_nome':
        if (!filtro) return { erro: 'filtro nome obrigatorio' };
        sql = `SELECT cnpj, razao_social, nome_fantasia, regime, status_gesthub,
                      mensalidade, socio_responsavel, analyst
               FROM datalake.cliente_360
               WHERE razao_social ILIKE '%'||$1||'%' OR nome_fantasia ILIKE '%'||$1||'%'
               ORDER BY mensalidade DESC LIMIT $2`;
        params = [filtro, limite];
        break;
      case 'carteira_socio':
        if (!filtro) return { erro: 'filtro (nome do socio) obrigatorio' };
        sql = `SELECT razao_social, nome_fantasia, cnpj, regime, mensalidade, status_gesthub
               FROM datalake.cliente_360
               WHERE socio_responsavel ILIKE '%'||$1||'%'
               ORDER BY mensalidade DESC LIMIT $2`;
        params = [filtro, limite];
        break;
      case 'resumo_carteira':
        sql = `SELECT socio_responsavel,
                      count(*) AS total,
                      sum(mensalidade) AS receita_mensal,
                      count(*) FILTER (WHERE status_gesthub='ativo') AS ativos
               FROM datalake.cliente_360
               GROUP BY socio_responsavel
               ORDER BY receita_mensal DESC NULLS LAST`;
        params = [];
        break;
      case 'clientes_sem_vinculo_luna':
        sql = `SELECT cnpj, razao_social, socio_responsavel
               FROM datalake.cliente_360
               WHERE luna_client_id IS NULL AND status_gesthub='ativo'
               LIMIT $1`;
        params = [limite];
        break;
      case 'total_clientes':
        sql = `SELECT count(*) AS total,
                      count(*) FILTER (WHERE status_gesthub='ativo') AS ativos,
                      count(*) FILTER (WHERE luna_client_id IS NOT NULL) AS com_luna,
                      sum(mensalidade) AS receita_total
               FROM datalake.cliente_360`;
        params = [];
        break;
      default:
        return { erro: `tipo desconhecido. Use: cliente_por_cnpj, cliente_por_nome, carteira_socio, resumo_carteira, clientes_sem_vinculo_luna, total_clientes` };
    }
    const r = await query(sql, params);
    return { ok: true, tipo, total: r.rowCount, dados: r.rows };
  } catch (e) {
    return { erro: e.message };
  }
}

export const tools = { consultar_datalake: consultarDatalake };
