// tools/auditor.js
// Tools do agente Auditor — cruza dados via Gesthub /api/audit.
// Host gesthub-app na rede docker (resolvido pelo container name).

const GESTHUB_AUDIT_URL = process.env.GESTHUB_AUDIT_URL || 'http://gesthub-app:8000/api/audit';

async function gh(path, opts = {}) {
  const res = await fetch(GESTHUB_AUDIT_URL + path, opts);
  if (!res.ok) throw new Error(`Gesthub audit ${res.status}: ${await res.text().then(t => t.slice(0, 200)).catch(() => '')}`);
  return res.json();
}

export const tools = {
  /**
   * Dashboard: totais, findings por severity, por sistema, últimos.
   */
  async auditoria_dashboard() {
    try {
      return await gh('/dashboard');
    } catch (e) { return { erro: e.message }; }
  },

  /**
   * Lista findings filtrados.
   * @param {string} severity critical|high|medium|low
   * @param {string} source   gesthub|omie|veri|gestta|gestbern|zapsign
   * @param {string} rule     codigo da regra
   * @param {number} limit    padrao 50
   */
  async auditoria_findings({ severity = null, source = null, rule = null, limit = 50 } = {}) {
    try {
      const params = new URLSearchParams({ status: 'open', limit: String(limit) });
      if (severity) params.set('severity', severity);
      if (source) params.set('source', source);
      if (rule) params.set('rule', rule);
      const r = await gh('/findings?' + params);
      return r.data || [];
    } catch (e) { return { erro: e.message }; }
  },

  /**
   * Dispara execução das regras (idempotente). Retorna totals.
   */
  async auditoria_rodar() {
    try {
      return await gh('/run', { method: 'POST' });
    } catch (e) { return { erro: e.message }; }
  },

  /**
   * Visão cruzada de um CNPJ específico em TODAS as fontes.
   */
  async auditoria_cruzar_cnpj({ cnpj }) {
    if (!cnpj) return { erro: 'Parametro cnpj obrigatorio' };
    try {
      return await gh('/cross/' + encodeURIComponent(cnpj));
    } catch (e) { return { erro: e.message }; }
  },

  /**
   * Relatório narrativo dos top findings críticos — para Caio no chat.
   */
  async auditoria_relatorio_diario() {
    try {
      const dash = await gh('/dashboard');
      const crit = await gh('/findings?status=open&severity=critical&limit=10');
      const high = await gh('/findings?status=open&severity=high&limit=10');

      const totals = dash.totals || {};
      const bySev = dash.by_severity || [];
      const bySource = dash.by_source || [];

      const bySrcStr = bySource.map(s => `${s.source}=${s.total}`).join(' · ');
      const critList = (crit.data || []).slice(0, 5).map(f =>
        `   • [${f.rule_code}] ${f.nome_canonico || 'sem nome'} (${f.cnpj_norm})`
      ).join('\n');
      const highList = (high.data || []).slice(0, 5).map(f =>
        `   • [${f.rule_code}] ${f.nome_canonico || 'sem nome'} (${f.cnpj_norm})`
      ).join('\n');

      const texto = [
        `📋 *Auditoria diaria* — ${new Date().toLocaleDateString('pt-BR')}`,
        ``,
        `Abertos: *${totals.open_total || 0}* (resolvidos hist.: ${totals.resolved_total || 0})`,
        `Por sistema: ${bySrcStr || '—'}`,
        ``,
        (crit.data || []).length
          ? `🚨 *CRITICAL (${(crit.data || []).length})*:\n${critList}` : '✓ Nenhum critical aberto',
        ``,
        (high.data || []).length
          ? `🔴 *HIGH (${(high.data || []).length})* (top 5):\n${highList}` : '',
      ].filter(Boolean).join('\n');

      return {
        texto,
        totals,
        by_severity: bySev,
        critical_count: (crit.data || []).length,
        high_count: (high.data || []).length,
      };
    } catch (e) { return { erro: e.message, texto: `Falha ao gerar relatorio: ${e.message}` }; }
  },
};
