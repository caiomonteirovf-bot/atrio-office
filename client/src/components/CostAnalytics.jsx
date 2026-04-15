import { useState, useEffect } from 'react'

export default function CostAnalytics() {
  const [data, setData] = useState({ daily: [], byAgent: [], totals: {} })
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/analytics/costs?days=${days}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [days])

  const t = data.totals || {}
  const budget = 50 // USD monthly budget estimate
  const projectedMonth = (parseFloat(t.cost_today || 0) * 30).toFixed(2)
  const budgetPct = budget > 0 ? Math.min((parseFloat(t.cost_month || 0) / budget) * 100, 100) : 0

  // Simple bar chart for daily costs
  const maxDailyCost = Math.max(...data.daily.map(d => d.cost), 0.001)

  // Agent breakdown - top agents by cost
  const agentsSorted = [...data.byAgent].sort((a, b) => b.cost - a.cost)
  const maxAgentCost = Math.max(...agentsSorted.map(a => a.cost), 0.001)

  const formatUSD = (v) => `$${parseFloat(v || 0).toFixed(4)}`
  const formatTokens = (v) => {
    const n = parseInt(v || 0)
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return n.toString()
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h2 style={{ color: 'var(--ao-text-primary)', fontSize: 20, fontWeight: 700, margin: 0 }}>
            Custos IA
          </h2>
          <p style={{ color: 'var(--ao-text-muted)', fontSize: 13, margin: '4px 0 0' }}>
            Monitoramento de tokens e custos por agente
          </p>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[7, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: `1px solid ${days === d ? 'rgba(196,149,106,0.3)' : 'var(--ao-border)'}`,
                background: days === d ? 'rgba(196,149,106,0.12)' : 'var(--ao-input-bg)',
                color: days === d ? '#C4956A' : 'var(--ao-text-muted)',
                fontSize: 12,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Custo Hoje', value: formatUSD(t.cost_today), color: '#C4956A' },
          { label: 'Custo Mês', value: formatUSD(t.cost_month), color: '#60a5fa' },
          { label: 'Projeção mês', value: formatUSD(projectedMonth), color: parseFloat(projectedMonth) > budget ? '#f87171' : '#22c55e' },
          { label: 'Tokens', value: formatTokens(t.total_tokens), color: '#a78bfa' },
        ].map((kpi, i) => (
          <div key={i} style={{
            background: 'var(--ao-card)',
            backdropFilter: 'blur(12px)',
            border: '1px solid var(--ao-border)',
            borderRadius: 12,
            padding: '18px 20px',
          }}>
            <div style={{ fontSize: 11, color: 'var(--ao-text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
              {kpi.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color }}>
              {loading ? '...' : kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* Budget Bar */}
      <div style={{
        background: 'var(--ao-card)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--ao-border)',
        borderRadius: 12,
        padding: '16px 20px',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--ao-text-muted)' }}>Orçamento Mensal</span>
          <span style={{ fontSize: 12, color: 'var(--ao-text-muted)' }}>
            {formatUSD(t.cost_month)} / ${budget.toFixed(2)}
          </span>
        </div>
        <div style={{ height: 8, background: 'var(--ao-border)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${budgetPct}%`,
            borderRadius: 4,
            background: budgetPct > 80 ? '#f87171' : budgetPct > 50 ? '#fbbf24' : '#C4956A',
            transition: 'width 0.5s ease',
          }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* Daily Cost Chart */}
        <div style={{
          background: 'var(--ao-card)',
          backdropFilter: 'blur(12px)',
          border: '1px solid var(--ao-border)',
          borderRadius: 12,
          padding: 20,
        }}>
          <h3 style={{ color: 'var(--ao-text-primary)', fontSize: 14, fontWeight: 600, margin: '0 0 16px' }}>
            Custo por dia
          </h3>
          {data.daily.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--ao-text-dim)', fontSize: 13 }}>
              Sem dados de custo no período
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 140 }}>
              {data.daily.slice(-30).map((d, i) => {
                const h = Math.max((d.cost / maxDailyCost) * 120, 2)
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div
                      title={`${d.date}: ${formatUSD(d.cost)} (${d.requests} req)`}
                      style={{
                        width: '100%',
                        maxWidth: 20,
                        height: h,
                        background: 'linear-gradient(180deg, #C4956A, rgba(196,149,106,0.4))',
                        borderRadius: '3px 3px 0 0',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Agent Breakdown */}
        <div style={{
          background: 'var(--ao-card)',
          backdropFilter: 'blur(12px)',
          border: '1px solid var(--ao-border)',
          borderRadius: 12,
          padding: 20,
        }}>
          <h3 style={{ color: 'var(--ao-text-primary)', fontSize: 14, fontWeight: 600, margin: '0 0 16px' }}>
            Por agente
          </h3>
          {agentsSorted.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--ao-text-dim)', fontSize: 13 }}>
              Sem dados
            </div>
          ) : agentsSorted.map((agent, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--ao-text-primary)' }}>{agent.name}</span>
                <span style={{ fontSize: 11, color: '#C4956A', fontFamily: 'monospace' }}>
                  {formatUSD(agent.cost)}
                </span>
              </div>
              <div style={{ height: 6, background: 'var(--ao-border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${(agent.cost / maxAgentCost) * 100}%`,
                  borderRadius: 3,
                  background: '#C4956A',
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', marginTop: 2 }}>
                {formatTokens(agent.input + agent.output)} tokens · {agent.requests} req
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
