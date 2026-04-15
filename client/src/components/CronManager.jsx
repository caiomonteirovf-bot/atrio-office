import { useState, useEffect } from 'react'

const SCHEDULE_LABELS = {
  '0 */4 * * *':     'A cada 4 horas',
  '0 */6 * * *':     'A cada 6 horas',
  '0 18 * * 1-5':    'Seg a Sex, 18h',
  '0 7 * * 1-5':     'Seg a Sex, 7h',
  '0 9,18 * * 1-5':  'Seg a Sex, 9h e 18h',
  '*/5 * * * *':     'A cada 5 minutos',
  '0 3 * * *':       'Todo dia, 3h da manha',
  '0 4 * * 0':       'Todo domingo, 4h',
}

// O que cada job faz, em portugues claro
const HANDLER_DESCRIPTIONS = {
  omie_sync:        'Sincroniza clientes e notas fiscais do Omie',
  gesthub_sync:     'Puxa atualizacoes do Gesthub (clientes, contratos)',
  relatorio_diario: 'Gera relatorio do dia e envia para a equipe',
  health_check:     'Verifica se todos os servicos estao no ar',
  backup_db:        'Backup completo do banco de dados',
  limpeza_logs:     'Remove logs e registros antigos (>90 dias)',
  alertas_fiscais:  'Verifica prazos fiscais e avisa responsaveis',
  memory_triggers:  'Revisa memorias dos agentes e ativa regras',
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
        <h2 style={{ color: 'var(--ao-text)', fontSize: 20, fontWeight: 700, margin: 0, fontFamily: 'Outfit' }}>
          Cron Manager
        </h2>
        <p style={{ color: 'var(--ao-text-secondary)', fontSize: 13, margin: '4px 0 0' }}>
          Rotinas automaticas que rodam sozinhas no horario marcado
        </p>
      </div>

      {/* KPI Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Rotinas ligadas', sub: 'de ' + crons.length + ' cadastradas', value: activeCount, color: '#22c55e' },
          { label: 'Execucoes totais', sub: 'desde o inicio', value: totalRuns, color: '#C4956A' },
          { label: 'Rotinas pausadas', sub: crons.length - activeCount ? 'nao estao rodando' : 'todas ativas', value: crons.length - activeCount, color: '#fbbf24' },
        ].map((kpi, i) => (
          <div key={i} style={{
            background: 'var(--ao-card)',
            border: '1px solid var(--ao-border)',
            borderRadius: 12,
            padding: '18px 22px',
            boxShadow: '0 2px 6px var(--ao-shadow), 0 8px 24px var(--ao-shadow)',
          }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: kpi.color, fontFamily: 'Space Grotesk' }}>
              {kpi.value}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ao-text-secondary)', marginTop: 3, fontWeight: 500 }}>{kpi.label}</div>
            {kpi.sub && <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)', marginTop: 1 }}>{kpi.sub}</div>}
          </div>
        ))}
      </div>

      {/* Cron Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
        {crons.map(cron => (
          <div key={cron.id} style={{
            background: 'var(--ao-card)',
            border: `1px solid ${cron.status === 'active' ? 'rgba(34,197,94,0.25)' : 'var(--ao-border)'}`,
            borderRadius: 12,
            padding: 20,
            transition: 'all 0.2s',
            boxShadow: '0 2px 6px var(--ao-shadow), 0 6px 18px var(--ao-shadow)',
          }}>
            {/* Card header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 24 }}>{HANDLER_ICONS[cron.handler] || '\u2699\uFE0F'}</span>
                <div>
                  <div style={{ color: 'var(--ao-text)', fontSize: 14, fontWeight: 600 }}>{cron.name}</div>
                  <div style={{ color: 'var(--ao-text-secondary)', fontSize: 11.5, marginTop: 2, lineHeight: 1.35 }}>{HANDLER_DESCRIPTIONS[cron.handler] || cron.description || cron.handler}</div>
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
                {cron.status === 'active' ? 'ligada' : cron.status === 'paused' ? 'pausada' : cron.status === 'failed' ? 'com erro' : cron.status}
              </div>
            </div>

            {/* Schedule + last run */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Quando roda</div>
                <div style={{ fontSize: 12, color: '#C4956A', fontWeight: 500 }} title={cron.schedule}>
                  {SCHEDULE_LABELS[cron.schedule] || cron.schedule}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Ultima execucao</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{formatDate(cron.last_run)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Resultado</div>
                <div style={{ fontSize: 12, color: cron.last_result === 'success' ? '#22c55e' : cron.last_result === 'error' ? '#f87171' : 'rgba(255,255,255,0.5)' }}>
                  {cron.last_result || '\u2014'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Execucoes ate hoje</div>
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
      <CleanupPanel/>
    </div>
  )
}

function CleanupPanel() {
  const [open, setOpen] = useState(false)
  const [audit, setAudit] = useState({})
  const [selected, setSelected] = useState(new Set())
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)

  async function loadAudit() {
    const r = await fetch('/api/admin/data-audit').then(r=>r.json()).catch(()=>({}))
    setAudit(r || {})
  }
  useEffect(() => { if (open) loadAudit() }, [open])

  function toggle(k) {
    setSelected(prev => {
      const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n
    })
  }

  async function run() {
    if (!selected.size) return
    if (!confirm(`Confirmar limpeza de ${selected.size} alvo(s)? Esta acao e irreversivel.`)) return
    setRunning(true); setResult(null)
    try {
      const r = await fetch('/api/admin/cleanup', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ targets: [...selected], confirm: 'LIMPAR' })
      }).then(r=>r.json())
      setResult(r); setSelected(new Set()); loadAudit()
    } catch(e) { setResult({ error: e.message }) }
    finally { setRunning(false) }
  }

  return (
    <div className="mt-8 rounded-xl overflow-hidden" style={{ border: '1px solid var(--ao-border)', background: 'var(--ao-card)' }}>
      <button onClick={()=>setOpen(o=>!o)}
        className="w-full flex items-center justify-between px-5 py-3 cursor-pointer"
        style={{ background: open ? 'var(--ao-hover-bg)' : 'transparent' }}>
        <div className="flex items-center gap-3">
          <span style={{ fontSize: 16 }}>{'\u{1F9F9}'}</span>
          <div className="text-left">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--ao-text)' }}>Limpeza de dados</div>
            <div className="text-[11px]" style={{ color: 'var(--ao-text-dim)' }}>Remove conversas/mensagens/tasks antigas ou de teste</div>
          </div>
        </div>
        <span style={{ color: 'var(--ao-text-dim)', fontSize: 18 }}>{open ? '\u2212' : '+'}</span>
      </button>

      {open && (
        <div className="p-5 border-t" style={{ borderColor: 'var(--ao-border)' }}>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {Object.entries(audit).map(([k, v]) => {
              const on = selected.has(k)
              const empty = !v.count
              return (
                <button key={k} disabled={empty} onClick={()=>toggle(k)}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-all"
                  style={{
                    background: on ? 'rgba(239,68,68,0.10)' : 'var(--ao-input-bg)',
                    border: '1px solid ' + (on ? '#ef4444' : 'var(--ao-border)'),
                    opacity: empty ? 0.4 : 1, cursor: empty ? 'not-allowed' : 'pointer'
                  }}>
                  <div>
                    <div className="text-[12px] font-medium" style={{ color: on ? '#ef4444' : 'var(--ao-text)' }}>{v.label}</div>
                    <div className="text-[10.5px]" style={{ color: 'var(--ao-text-dim)' }}>{v.count} registro(s)</div>
                  </div>
                  {on && <span style={{ color: '#ef4444', fontSize: 13 }}>{'\u2713'}</span>}
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px]" style={{ color: 'var(--ao-text-dim)' }}>
              {selected.size ? `${selected.size} alvo(s) selecionado(s)` : 'Selecione os alvos para limpar'}
            </div>
            <div className="flex gap-2">
              <button onClick={()=>setSelected(new Set())} className="ao-btn-ghost" disabled={!selected.size}>Limpar selecao</button>
              <button onClick={run} disabled={!selected.size || running}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12.5px] font-semibold"
                style={{ background: selected.size ? '#ef4444' : 'var(--ao-input-bg)', color: selected.size ? '#fff' : 'var(--ao-text-dim)', border: '1px solid ' + (selected.size ? '#ef4444' : 'var(--ao-border)') }}>
                {running ? 'Limpando...' : 'Executar limpeza'}
              </button>
            </div>
          </div>
          {result && (
            <div className="mt-4 p-3 rounded-lg text-[11.5px]" style={{ background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border)', color: 'var(--ao-text)' }}>
              {result.error ? <span style={{ color:'#ef4444' }}>Erro: {result.error}</span> :
                Object.entries(result.results || {}).map(([k,v]) => (
                  <div key={k}>{v.error ? `${k}: ERRO - ${v.error}` : `\u2713 ${v.label}: ${v.deleted} removidos`}</div>
                ))
              }
            </div>
          )}
        </div>
      )}
    </div>
  )
}
