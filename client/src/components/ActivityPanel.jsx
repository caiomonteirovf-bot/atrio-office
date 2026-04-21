import { useState, useEffect } from 'react'
import { Loader2, Activity, AlertCircle, AlertTriangle, CheckCircle2, RefreshCw, Shield } from 'lucide-react'

const SEVERITY_STYLE = {
  info:     { icon: CheckCircle2, color: 'rgb(34 197 94)',  bg: 'color-mix(in oklab, green 8%, var(--ao-surface))' },
  warn:     { icon: AlertTriangle, color: 'rgb(234 179 8)', bg: 'color-mix(in oklab, orange 10%, var(--ao-surface))' },
  error:    { icon: AlertCircle, color: 'rgb(239 68 68)',   bg: 'color-mix(in oklab, red 10%, var(--ao-surface))' },
  critical: { icon: AlertCircle, color: 'rgb(185 28 28)',   bg: 'color-mix(in oklab, red 18%, var(--ao-surface))' },
}

export default function ActivityPanel() {
  const [events, setEvents] = useState([])
  const [summary, setSummary] = useState([])
  const [filters, setFilters] = useState({ event_type: '', severity: '', q: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detail, setDetail] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams(Object.entries(filters).filter(([,v]) => v)).toString()
      const [evRes, sumRes] = await Promise.all([
        fetch('/api/activity?limit=200&' + qs).then(r => r.json()),
        fetch('/api/activity/summary').then(r => r.json()),
      ])
      setEvents(evRes.data || [])
      setSummary(sumRes.data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, []) // eslint-disable-line
  useEffect(() => { load() }, [filters]) // eslint-disable-line

  const fmtTime = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <div className="flex flex-col gap-3">
      {/* Summary cards */}
      <div className="flex flex-wrap gap-2">
        {summary.map((s, i) => {
          const sty = SEVERITY_STYLE[s.severity] || SEVERITY_STYLE.info
          const Icon = sty.icon
          return (
            <button key={i}
              onClick={() => setFilters({ ...filters, event_type: s.event_type === filters.event_type ? '' : s.event_type })}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs"
              style={{ background: sty.bg, border: `1px solid ${filters.event_type === s.event_type ? sty.color : 'var(--ao-border)'}`, color: sty.color }}>
              <Icon size={12} />
              <span style={{ color: 'var(--ao-text)' }}>{s.event_type}</span>
              <span className="font-semibold">{s.total}</span>
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={filters.severity} onChange={e => setFilters({ ...filters, severity: e.target.value })}
          className="px-2 py-1 rounded border text-xs" style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }}>
          <option value="">Todas severidades</option>
          <option value="info">info</option><option value="warn">warn</option>
          <option value="error">error</option><option value="critical">critical</option>
        </select>
        <input value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} placeholder="buscar no payload..."
          className="px-2 py-1 rounded border text-xs flex-1 min-w-[200px]"
          style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }} />
        <button onClick={load} className="flex items-center gap-1 px-2 py-1 rounded text-xs"
          style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
          <RefreshCw size={12} /> Atualizar
        </button>
        <span className="text-xs opacity-60 flex items-center gap-1">
          <Shield size={12} /> append-only · secrets redacted
        </span>
      </div>

      {error && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-3"
          style={{ background: 'color-mix(in oklab, red 10%, var(--ao-surface))', border: '1px solid color-mix(in oklab, red 30%, var(--ao-border))' }}>
          <AlertCircle size={18} style={{ color: 'rgb(239 68 68)' }} />
          <div className="flex-1">{error}</div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8 opacity-60"><Loader2 className="animate-spin" /></div>
      ) : events.length === 0 ? (
        <div className="py-8 text-center opacity-60 text-sm">Nenhum evento com esse filtro.</div>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--ao-border)' }}>
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--ao-surface)' }}>
              <tr>
                <th className="text-left p-2 w-36">Quando</th>
                <th className="text-left p-2 w-20">Severity</th>
                <th className="text-left p-2">Evento</th>
                <th className="text-left p-2 w-32">Ator</th>
                <th className="text-left p-2">Entidade</th>
                <th className="text-left p-2">Resumo</th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => {
                const sty = SEVERITY_STYLE[ev.severity] || SEVERITY_STYLE.info
                return (
                  <tr key={ev.id} className="border-t cursor-pointer hover:opacity-90"
                    style={{ borderColor: 'var(--ao-border)' }}
                    onClick={() => setDetail(ev)}>
                    <td className="p-2 opacity-70">{fmtTime(ev.ts)}</td>
                    <td className="p-2"><span style={{ color: sty.color, fontWeight: 600 }}>{ev.severity}</span></td>
                    <td className="p-2" title={`${ev.event_type}/${ev.action || ''}`}>
                      <span className="mr-1">{ev.event_icon || '•'}</span>
                      <span className="font-medium">{ev.event_label || ev.event_type}</span>
                    </td>
                    <td className="p-2 truncate max-w-[180px]" title={`${ev.actor_type}/${ev.actor_id || ''}`}>{ev.resolved_agent_name || ev.actor_label || ev.actor_type}</td>
                    <td className="p-2 truncate max-w-[220px]" title={ev.entity_id}>{ev.entity_label || '—'}</td>
                    <td className="p-2 opacity-80 truncate max-w-[320px]">{ev.summary_text || ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div onClick={() => setDetail(null)} className="fixed inset-0 z-[200] flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div onClick={e => e.stopPropagation()} className="rounded-lg max-w-2xl w-full overflow-hidden flex flex-col"
            style={{ background: 'var(--ao-bg)', border: '1px solid var(--ao-border)' }}>
            <div className="px-4 py-2 border-b flex items-center justify-between" style={{ borderColor: 'var(--ao-border)' }}>
              <div className="text-sm font-medium">{detail.event_type} / {detail.action}</div>
              <button onClick={() => setDetail(null)} className="opacity-60 hover:opacity-100 text-sm">✕</button>
            </div>
            <div className="p-4 space-y-3 text-xs overflow-auto" style={{ maxHeight: '70vh' }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Quando" value={fmtTime(detail.ts)} />
                <Field label="Severity" value={detail.severity} />
                <Field label="Ator" value={`${detail.actor_type} · ${detail.actor_name || detail.actor_id || '—'}`} />
                <Field label="Source" value={detail.source || '—'} />
                <Field label="Entidade" value={detail.entity_type ? `${detail.entity_type}:${detail.entity_id}` : '—'} />
                <Field label="Hash integridade" value={detail.payload_hash || '—'} mono />
              </div>
              <div>
                <div className="opacity-60 mb-1">Payload (já com secrets redacted)</div>
                <pre className="p-2 rounded overflow-auto text-xs"
                  style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
{JSON.stringify(detail.payload, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, mono = false }) {
  return (
    <div>
      <div className="opacity-60 mb-0.5">{label}</div>
      <div className={mono ? 'font-mono break-all' : 'break-words'}>{value}</div>
    </div>
  )
}
