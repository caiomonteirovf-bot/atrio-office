import { useState, useEffect } from 'react'

const SCHEDULE_LABELS = {
  '0 */4 * * *': 'A cada 4h',
  '0 */6 * * *': 'A cada 6h',
  '0 18 * * 1-5': 'Seg-Sex 18h',
  '*/5 * * * *': 'A cada 5min',
  '0 3 * * *': 'Diário 3h',
  '0 4 * * 0': 'Domingo 4h',
}

const STATUS_COLORS = {
  active: '#22c55e',
  paused: '#fbbf24',
  failed: '#f87171',
}

const HANDLER_ICONS = {
  omie_sync: '\u{1F4B0}',
  gesthub_sync: '\u{1F4CB}',
  relatorio_diario: '\u{1F4CA}',
  health_check: '\u{1F3E5}',
  backup_db: '\u{1F4BE}',
  limpeza_logs: '\u{1F9F9}',
}

export default function CronManager() {
  const [crons, setCrons] = useState([])
  const [runs, setRuns] = useState({})
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  const fetchCrons = () => {
    fetch('/api/crons')
      .then(r => r.json())
      .then(d => { setCrons(d.crons || []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { fetchCrons() }, [])

  const toggleStatus = async (cron) => {
    const newStatus = cron.status === 'active' ? 'paused' : 'active'
    await fetch(`/api/crons/${cron.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    })
    fetchCrons()
  }

  const triggerCron = async (cron) => {
    setTriggering(cron.id)
    await fetch(`/api/crons/${cron.id}/trigger`, { method: 'POST' })
    setTimeout(() => { setTriggering(null); fetchCrons() }, 1000)
  }

  const loadRuns = async (cronId) => {
    if (expandedId === cronId) { setExpandedId(null); return }
    const res = await fetch(`/api/crons/${cronId}/runs?limit=10`)
    const data = await res.json()
    setRuns(prev => ({ ...prev, [cronId]: data.runs || [] }))
    setExpandedId(cronId)
  }

  const formatDate = (d) => {
    if (!d) return '\u2014'
    const date = new Date(d)
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  const activeCount = crons.filter(c => c.status === 'active').length
  const totalRuns = crons.reduce((s, c) => s + (c.run_count || 0), 0)

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 40, color: 'rgba(255,255,255,0.5)' }}>
      Carregando crons...
    </div>
  )

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ color: 'rgba(255,255,255,0.85)', fontSize: 20, fontWeight: 700, margin: 0 }}>
          Cron Manager
        </h2>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, margin: '4px 0 0' }}>
          Gerenciamento visual de tarefas agendadas
        </p>
      </div>

      {/* KPI Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Jobs Ativos', value: activeCount, total: crons.length, color: '#22c55e' },
          { label: 'Total Execuções', value: totalRuns, color: '#C4956A' },
          { label: 'Jobs Pausados', value: crons.length - activeCount, color: '#fbbf24' },
        ].map((kpi, i) => (
          <div key={i} style={{
            background: 'linear-gradient(135deg, rgba(19,22,32,0.8) 0%, rgba(19,22,32,0.6) 100%)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 12,
            padding: '16px 20px',
          }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: kpi.color }}>
              {kpi.value}{kpi.total !== undefined ? `/${kpi.total}` : ''}
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{kpi.label}</div>
          </div>
        ))}
      </div>

      {/* Cron Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
        {crons.map(cron => (
          <div key={cron.id} style={{
            background: 'linear-gradient(135deg, rgba(19,22,32,0.8) 0%, rgba(19,22,32,0.6) 100%)',
            backdropFilter: 'blur(12px)',
            border: `1px solid ${cron.status === 'active' ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)'}`,
            borderRadius: 12,
            padding: 20,
            transition: 'all 0.2s',
          }}>
            {/* Card header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 24 }}>{HANDLER_ICONS[cron.handler] || '\u2699\uFE0F'}</span>
                <div>
                  <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: 600 }}>{cron.name}</div>
                  <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 2 }}>{cron.description}</div>
                </div>
              </div>
              <div style={{
                padding: '3px 8px',
                borderRadius: 6,
                fontSize: 10,
                fontWeight: 600,
                textTransform: 'uppercase',
                background: `${STATUS_COLORS[cron.status] || '#666'}20`,
                color: STATUS_COLORS[cron.status] || '#666',
              }}>
                {cron.status}
              </div>
            </div>

            {/* Schedule + last run */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 2 }}>Schedule</div>
                <div style={{ fontSize: 12, color: '#C4956A', fontFamily: 'monospace' }}>
                  {SCHEDULE_LABELS[cron.schedule] || cron.schedule}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 2 }}>Última execução</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{formatDate(cron.last_run)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 2 }}>Resultado</div>
                <div style={{ fontSize: 12, color: cron.last_result === 'success' ? '#22c55e' : cron.last_result === 'error' ? '#f87171' : 'rgba(255,255,255,0.5)' }}>
                  {cron.last_result || '\u2014'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 2 }}>Execuções</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{cron.run_count || 0}x</div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => toggleStatus(cron)}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.7)',
                  fontSize: 12,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {cron.status === 'active' ? 'Pausar' : 'Ativar'}
              </button>
              <button
                onClick={() => triggerCron(cron)}
                disabled={triggering === cron.id}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  borderRadius: 6,
                  border: '1px solid rgba(196,149,106,0.2)',
                  background: triggering === cron.id ? 'rgba(196,149,106,0.2)' : 'rgba(196,149,106,0.08)',
                  color: '#C4956A',
                  fontSize: 12,
                  cursor: triggering === cron.id ? 'default' : 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {triggering === cron.id ? 'Executando...' : 'Executar agora'}
              </button>
              <button
                onClick={() => loadRuns(cron.id)}
                style={{
                  padding: '7px 12px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: expandedId === cron.id ? 'rgba(196,149,106,0.1)' : 'rgba(255,255,255,0.04)',
                  color: expandedId === cron.id ? '#C4956A' : 'rgba(255,255,255,0.5)',
                  fontSize: 12,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                Hist.
              </button>
            </div>

            {/* Run History (expanded) */}
            {expandedId === cron.id && runs[cron.id] && (
              <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8 }}>Histórico recente</div>
                {runs[cron.id].length === 0 ? (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center', padding: 8 }}>
                    Nenhuma execução registrada
                  </div>
                ) : runs[cron.id].map((run, i) => (
                  <div key={run.id || i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '6px 0',
                    borderBottom: i < runs[cron.id].length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: run.status === 'success' ? '#22c55e' : '#f87171'
                      }} />
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{formatDate(run.started_at)}</span>
                    </div>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                      {run.duration_ms ? `${run.duration_ms}ms` : '\u2014'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
