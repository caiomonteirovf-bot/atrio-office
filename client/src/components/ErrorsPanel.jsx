import { useState, useEffect } from 'react'
import { AlertCircle, Loader2, RefreshCw, CheckCircle2, XCircle, ChevronRight, Shield } from 'lucide-react'

const LEVEL_STYLE = {
  warn:     { bg: 'color-mix(in oklab, orange 12%, transparent)', color: 'rgb(234 179 8)'   },
  error:    { bg: 'color-mix(in oklab, red 12%, transparent)',    color: 'rgb(239 68 68)'   },
  critical: { bg: 'color-mix(in oklab, red 22%, transparent)',    color: 'rgb(185 28 28)'   },
}

export default function ErrorsPanel() {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [showResolved, setShowResolved] = useState(false)
  const [detail, setDetail] = useState(null)
  const [occurrences, setOccurrences] = useState([])
  const [error, setError] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/errors/groups?resolved=${showResolved}`)
      const d = await r.json()
      setGroups(d.data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [showResolved]) // eslint-disable-line

  const openDetail = async (group) => {
    setDetail(group)
    try {
      const r = await fetch(`/api/errors/group/${group.fingerprint}`)
      const d = await r.json()
      setOccurrences(d.data || [])
    } catch (e) { setError(e.message) }
  }

  const resolve = async (fp) => {
    try {
      const r = await fetch(`/api/errors/group/${fp}/resolve`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.error || 'falha')
      setDetail(null)
      await load()
    } catch (e) { setError(e.message) }
  }

  const fmt = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs">
        <button onClick={() => setShowResolved(!showResolved)}
          className="px-3 py-1.5 rounded border"
          style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }}>
          {showResolved ? 'Mostrando resolvidos' : 'Mostrando ativos'} · clique para alternar
        </button>
        <button onClick={load} className="flex items-center gap-1 px-2 py-1.5 rounded"
          style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
          <RefreshCw size={12} /> atualizar
        </button>
        <span className="ml-auto opacity-60 flex items-center gap-1">
          <Shield size={12} /> {groups.length} grupo(s) de erro
        </span>
      </div>

      {error && (
        <div className="rounded p-2 text-xs" style={{ background: 'color-mix(in oklab, red 10%, transparent)', color: 'rgb(239 68 68)' }}>{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10 opacity-60"><Loader2 className="animate-spin" /></div>
      ) : groups.length === 0 ? (
        <div className="py-10 text-center opacity-60 text-sm flex flex-col items-center gap-2">
          <CheckCircle2 size={32} style={{ color: 'rgb(34 197 94)' }} />
          Nenhum erro {showResolved ? 'resolvido' : 'ativo'}.
        </div>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--ao-border)' }}>
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--ao-surface)' }}>
              <tr>
                <th className="text-left p-2 w-20">Level</th>
                <th className="text-left p-2 w-24">Kind</th>
                <th className="text-left p-2">Mensagem</th>
                <th className="text-right p-2 w-16">Qtd</th>
                <th className="text-left p-2 w-32">Primeira</th>
                <th className="text-left p-2 w-32">Última</th>
                <th className="w-8 p-2"></th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const sty = LEVEL_STYLE[g.level] || LEVEL_STYLE.error
                return (
                  <tr key={g.fingerprint} className="border-t cursor-pointer hover:opacity-90"
                    style={{ borderColor: 'var(--ao-border)' }}
                    onClick={() => openDetail(g)}>
                    <td className="p-2"><span style={{ color: sty.color, fontWeight: 600 }}>{g.level}</span></td>
                    <td className="p-2 opacity-70">{g.kind}</td>
                    <td className="p-2 max-w-[500px] truncate font-mono text-[11px]" title={g.message}>{g.message}</td>
                    <td className="p-2 text-right font-semibold">{g.occurrences}</td>
                    <td className="p-2 opacity-70">{fmt(g.first_seen)}</td>
                    <td className="p-2 opacity-70">{fmt(g.last_seen)}</td>
                    <td className="p-2"><ChevronRight size={12} className="opacity-40" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div onClick={() => setDetail(null)} className="fixed inset-0 z-[200] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div onClick={e => e.stopPropagation()} className="rounded-lg max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            style={{ background: 'var(--ao-bg)', border: '1px solid var(--ao-border)' }}>
            <div className="px-4 py-2 border-b flex items-center justify-between" style={{ borderColor: 'var(--ao-border)' }}>
              <div>
                <div className="text-sm font-medium">{detail.kind} · {detail.message.slice(0, 80)}</div>
                <div className="text-[10px] opacity-60 font-mono">fingerprint: {detail.fingerprint}</div>
              </div>
              <div className="flex items-center gap-2">
                {!detail.all_resolved && (
                  <button onClick={() => resolve(detail.fingerprint)} className="px-2 py-1 rounded text-xs"
                    style={{ background: 'rgb(34 197 94)', color: 'white' }}>marcar resolvido</button>
                )}
                <button onClick={() => setDetail(null)} className="opacity-60 hover:opacity-100">✕</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-3 text-xs">
              <div className="opacity-70">Últimas {occurrences.length} ocorrências:</div>
              {occurrences.map(o => (
                <div key={o.id} className="rounded p-2" style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="opacity-70">{fmt(o.ts)}</span>
                    {o.method && <span className="opacity-70 font-mono">{o.method} {o.url}</span>}
                    {o.status_code && <span className="px-1.5 rounded" style={{ background: LEVEL_STYLE[o.level]?.bg }}>{o.status_code}</span>}
                  </div>
                  {o.stack && (
                    <pre className="overflow-auto text-[10px] p-2 rounded" style={{ background: 'var(--ao-bg)', maxHeight: '200px' }}>{o.stack}</pre>
                  )}
                  {o.context && Object.keys(o.context).length > 0 && (
                    <pre className="overflow-auto text-[10px] mt-1 opacity-80">{JSON.stringify(o.context, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
