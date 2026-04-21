import { useState, useEffect } from 'react'
import { Clock, FileText, MessageCircle, DollarSign, TrendingUp, TrendingDown, Minus, Loader2 } from 'lucide-react'

/**
 * Dashboard de Impacto — 4 KPIs que importam.
 * Mostra valor atual + delta vs mês anterior.
 */
export default function ImpactDashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/metrics/impact').then(r => r.json())
      setData(r)
      setError(null)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 5 * 60 * 1000)  // refresh 5min
    return () => clearInterval(t)
  }, [])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-10 opacity-60">
        <Loader2 className="animate-spin" size={20} />
      </div>
    )
  }

  if (error) return <div className="text-sm text-red-500">Erro: {error}</div>
  if (!data?.kpis) return null

  const k = data.kpis
  const horasEcon = k.horas_economizadas.atual.horas
  const nfseOk = k.nfse.atual.emitidas ?? 0
  const nfseErro = k.nfse.atual.erros ?? 0
  const lunaPct = k.luna_autonomia.atual.autonomia_pct
  const custoBrl = k.custo_llm.atual.custo_brl
  const clientes = k.custo_llm.atual.clientes_ativos
  const custoClienteBrl = k.custo_llm.atual.custo_por_cliente_brl

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, letterSpacing: '-0.3px' }}>Impacto do mês</h3>
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            {fmtPeriod(data.periodo_atual)} · atualizado {fmtAgo(data.generated_at)}
          </div>
        </div>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 12,
      }}>
        <KpiCard
          icon={<Clock size={18} />}
          title="Horas economizadas"
          value={`${horasEcon}h`}
          subtitle={`${k.horas_economizadas.atual.tasks} tasks automáticas`}
          delta={k.horas_economizadas.delta_pct}
          color="#10b981"
        />
        <KpiCard
          icon={<FileText size={18} />}
          title="NFS-e emitidas"
          value={nfseOk == null ? '—' : String(nfseOk)}
          subtitle={
            nfseOk == null
              ? 'NFS-e System off'
              : nfseErro > 0
                ? `${nfseErro} com erro`
                : `${k.nfse.atual.pendentes || 0} pendente${(k.nfse.atual.pendentes || 0) === 1 ? '' : 's'}`
          }
          subtitleWarn={nfseErro > 0}
          delta={k.nfse.delta_pct}
          color="#3b82f6"
        />
        <KpiCard
          icon={<MessageCircle size={18} />}
          title="Luna autônoma"
          value={`${lunaPct}%`}
          subtitle={`${k.luna_autonomia.atual.sem_intervencao_humana}/${k.luna_autonomia.atual.total_conversas} conversas`}
          delta={k.luna_autonomia.delta_pct}
          color="#f59e0b"
        />
        <KpiCard
          icon={<DollarSign size={18} />}
          title="Custo IA"
          value={`R$ ${custoBrl.toFixed(2)}`}
          subtitle={
            custoClienteBrl != null
              ? `R$ ${custoClienteBrl}/cliente (${clientes})`
              : `${k.custo_llm.atual.chamadas} chamadas`
          }
          delta={k.custo_llm.delta_pct}
          deltaInverted
          color="#a855f7"
          footer={k.custo_llm.atual.cache_hit_pct > 0
            ? `${k.custo_llm.atual.cache_hit_pct}% cache hit`
            : null}
        />
      </div>
    </div>
  )
}

function KpiCard({ icon, title, value, subtitle, subtitleWarn, delta, deltaInverted, color, footer }) {
  const isUp = delta != null && delta > 1
  const isDown = delta != null && delta < -1
  // Se deltaInverted=true (custo), subir é ruim e descer é bom
  const trendColor = deltaInverted
    ? (isUp ? '#ef4444' : isDown ? '#10b981' : '#94a3b8')
    : (isUp ? '#10b981' : isDown ? '#ef4444' : '#94a3b8')
  const TrendIcon = isUp ? TrendingUp : isDown ? TrendingDown : Minus

  return (
    <div style={{
      padding: 14,
      background: 'var(--ao-surface, #1a1a1e)',
      border: '1px solid var(--ao-border, rgba(255,255,255,0.06))',
      borderRadius: 10,
      borderTop: `2px solid ${color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ color, opacity: 0.9 }}>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: 0.7 }}>
          {title}
        </span>
      </div>
      <div style={{
        fontSize: 28, fontWeight: 700, lineHeight: 1.1, color: 'var(--ao-text-primary, white)',
        fontVariantNumeric: 'tabular-nums', marginBottom: 2,
      }}>
        {value}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.8 }}>
        <span style={{ color: subtitleWarn ? '#ef4444' : 'var(--ao-text-dim, #94a3b8)' }}>{subtitle}</span>
        {delta != null && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 2,
            marginLeft: 'auto', color: trendColor, fontWeight: 600,
          }}>
            <TrendIcon size={11} />
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      {footer && (
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4, fontStyle: 'italic' }}>
          {footer}
        </div>
      )}
    </div>
  )
}

function fmtPeriod(yyyymm) {
  const [y, m] = (yyyymm || '').split('-')
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  return m && y ? `${meses[parseInt(m) - 1]}/${y}` : '—'
}

function fmtAgo(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.round(s / 60)}min`
  return `há ${Math.round(s / 3600)}h`
}
