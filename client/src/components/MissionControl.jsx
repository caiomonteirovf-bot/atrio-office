import { useState, useEffect, useCallback, useRef } from 'react'
import TaskDetailModal from './TaskDetailModal'
import { Activity, Clock, AlertTriangle, CheckCircle2, RefreshCw, Loader2, X, RotateCcw, Zap, User } from 'lucide-react'

const AGENT_COLORS = {
  Rodrigo: '#8b5cf6',
  Campelo: '#378ADD',
  Sneijder: '#10b981',
  Luna: '#f59e0b',
  Saldanha: '#ec4899',
  'André': '#06b6d4',
  Auditor: '#ef4444',
}

const PRIORITY_COLORS = {
  urgent: '#dc2626',
  high: '#f97316',
  medium: '#eab308',
  low: '#64748b',
}

export default function MissionControl({ ws }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [actioningId, setActioningId] = useState(null)
  const [error, setError] = useState(null)
  const [openTaskId, setOpenTaskId] = useState(null)
  const [tab, setTab] = useState('overview')   // overview | blocked | done
  const refreshTimer = useRef(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/mission-control').then(r => r.json())
      if (r.ok) {
        setData(r)
        setError(null)
      } else {
        setError(r.error || 'falha')
      }
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    refreshTimer.current = setInterval(load, 15_000)   // refresh 15s
    return () => clearInterval(refreshTimer.current)
  }, [load])

  // Também escuta eventos WebSocket pra refresh imediato
  useEffect(() => {
    if (!ws) return
    const handler = (evt) => {
      try {
        const m = JSON.parse(evt.data)
        if (['task_updated', 'task_completed', 'task_blocked', 'task_created'].includes(m.type)) {
          load()
        }
      } catch {}
    }
    ws.addEventListener?.('message', handler)
    return () => ws.removeEventListener?.('message', handler)
  }, [ws, load])

  const unblock = async (id) => {
    setActioningId(id)
    try {
      const r = await fetch(`/api/tasks/${id}/unblock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || 'falha')
      await load()
    } catch (e) { alert('Erro: ' + e.message) }
    finally { setActioningId(null) }
  }

  const cancel = async (id) => {
    if (!confirm('Cancelar essa task permanentemente?')) return
    setActioningId(id)
    try {
      const r = await fetch(`/api/tasks/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || 'falha')
      await load()
    } catch (e) { alert('Erro: ' + e.message) }
    finally { setActioningId(null) }
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-8 opacity-60">
        <Loader2 className="animate-spin" size={20} />
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="flex flex-col gap-3">
      {/* Header + contadores */}
      <div className="flex items-center justify-between">
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, letterSpacing: '-0.3px' }}>
            <Activity size={14} style={{ display: 'inline', marginRight: 6, marginBottom: -2, color: '#10b981' }} />
            Mission Control
          </h3>
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            Sessões ativas em tempo real · atualiza a cada 15s
          </div>
        </div>
        <button onClick={async () => { setRefreshing(true); await load(); setTimeout(() => setRefreshing(false), 400); }}
          disabled={refreshing}
          style={{
          padding: '4px 10px', fontSize: 11, borderRadius: 4, border: '1px solid var(--ao-border)',
          background: 'transparent', color: 'var(--ao-text-dim)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <RefreshCw size={10} style={{ animation: refreshing ? "spin 0.6s linear infinite" : "none" }} /> {refreshing ? "Atualizando..." : "Atualizar"}
        </button>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--ao-border)' }}>
        {[
          ['overview', 'Agora', data.totals.active + data.totals.pending, '#10b981'],
          ['blocked',  'Bloqueadas', data.totals.blocked, '#ef4444'],
          ['done',     'Concluídas 24h', data.totals.recent_done, '#3b82f6'],
        ].map(([id, label, count, color]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '6px 12px', fontSize: 11, fontWeight: tab === id ? 700 : 500,
            border: 'none', background: 'transparent', cursor: 'pointer',
            borderBottom: tab === id ? `2px solid ${color}` : '2px solid transparent',
            color: tab === id ? color : 'var(--ao-text-dim)',
            marginBottom: -1, display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {label}
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 700,
              background: `${color}20`, color,
            }}>{count}</span>
          </button>
        ))}
      </div>

      {error && (
        <div style={{ padding: 8, fontSize: 11, color: '#ef4444', background: '#ef262620', borderRadius: 4 }}>
          Erro: {error}
        </div>
      )}

      {/* OVERVIEW: ativas + pendentes */}
      {tab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.active.length === 0 && data.pending.length === 0 && (
            <EmptyState icon={<Zap />} message="Nenhum agente trabalhando agora" />
          )}

          {data.active.map(t => (
            <TaskCard key={t.id} task={t} variant="active" onClick={() => setOpenTaskId(t.id)} />
          ))}

          {data.pending.length > 0 && (
            <div style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 8, marginBottom: 2 }}>
              Aguardando processamento
            </div>
          )}
          {data.pending.slice(0, 10).map(t => (
            <TaskCard key={t.id} task={t} variant="pending" onClick={() => setOpenTaskId(t.id)} />
          ))}
          {data.pending.length > 10 && (
            <div style={{ fontSize: 10, opacity: 0.5, padding: 4 }}>
              + {data.pending.length - 10} pendentes...
            </div>
          )}
        </div>
      )}

      {/* BLOCKED */}
      {tab === 'blocked' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.blocked.length === 0 && (
            <EmptyState icon={<CheckCircle2 />} message="Nada bloqueado — sistema fluindo" color="#10b981" />
          )}
          {data.blocked.map(t => (
            <BlockedCard key={t.id} onClick={() => setOpenTaskId(t.id)}
              task={t}
              onUnblock={() => unblock(t.id)}
              onCancel={() => cancel(t.id)}
              busy={actioningId === t.id}
            />
          ))}
        </div>
      )}

      {/* DONE */}
      {tab === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.recent_done.length === 0 && (
            <EmptyState icon={<Clock />} message="Nenhuma task concluída nas últimas 24h" />
          )}
          {data.recent_done.map(t => (
            <DoneRow key={t.id} task={t} onClick={() => setOpenTaskId(t.id)} />
          ))}
        </div>
      )}
      {openTaskId && <TaskDetailModal taskId={openTaskId} onClose={() => setOpenTaskId(null)} ws={ws} />}
    </div>
  )
}

// ============================================================
// CARDS
// ============================================================

function TaskCard({ task, variant, onClick }) {
  const color = AGENT_COLORS[task.assigned_name] || '#64748b'
  const bg = variant === 'active' ? `${color}08` : 'transparent'
  const border = variant === 'active' ? `1px solid ${color}40` : '1px solid var(--ao-border)'

  return (
    <div onClick={onClick} style={{
      padding: '8px 12px', background: bg, border, borderRadius: 6,
      borderLeft: `3px solid ${color}`,
      display: 'flex', alignItems: 'center', gap: 10,
      cursor: onClick ? 'pointer' : 'default',
      transition: 'background 0.15s',
    }}>
      <AgentDot name={task.assigned_name} color={color} active={variant === 'active'} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ao-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.title}
        </div>
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 1, display: 'flex', gap: 6 }}>
          <span style={{ color }}>{task.assigned_name || '—'}</span>
          <span>·</span>
          {variant === 'active' && <span>rodando há {fmtMin(task.age_min)}</span>}
          {variant === 'pending' && <span>aguarda há {fmtMin(task.waiting_min)}</span>}
          {task.priority && task.priority !== 'medium' && (
            <>
              <span>·</span>
              <span style={{ color: PRIORITY_COLORS[task.priority] || '#64748b', fontWeight: 600, textTransform: 'uppercase', fontSize: 9 }}>
                {task.priority}
              </span>
            </>
          )}
        </div>
      </div>
      {variant === 'active' && (
        <div style={{
          width: 8, height: 8, borderRadius: '50%', background: color,
          boxShadow: `0 0 8px ${color}`, animation: 'pulse 1.5s ease-in-out infinite',
        }} />
      )}
    </div>
  )
}

function BlockedCard({ task, onUnblock, onCancel, busy, onClick }) {
  const erroTxt = task.erro || 'sem detalhe'
  const hasTool = Array.isArray(task.tool_failures) && task.tool_failures.length > 0
  return (
    <div onClick={onClick} style={{
      padding: 10, background: '#ef262608', border: '1px solid #ef262640', borderRadius: 6,
      borderLeft: '3px solid #ef4444',
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <AlertTriangle size={14} style={{ color: '#ef4444', marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{task.title}</div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
            {task.assigned_name || '—'} · há {fmtAgo(task.updated_at)}
          </div>
          <div style={{ fontSize: 10, marginTop: 6, padding: '4px 8px', background: 'var(--ao-surface)', borderRadius: 4, fontFamily: 'monospace', opacity: 0.85 }}>
            {String(erroTxt).slice(0, 200)}
            {hasTool && task.tool_failures[0].name && ` · tool: ${task.tool_failures[0].name}`}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button onClick={onUnblock} disabled={busy} title="Reprocessar" style={{
            padding: '4px 10px', fontSize: 10, fontWeight: 600, border: 'none', borderRadius: 4,
            background: busy ? '#94a3b8' : '#10b981', color: 'white', cursor: busy ? 'wait' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <RotateCcw size={10} /> {busy ? '...' : 'Retentar'}
          </button>
          <button onClick={onCancel} disabled={busy} title="Cancelar" style={{
            padding: '4px 10px', fontSize: 10, fontWeight: 500, borderRadius: 4,
            border: '1px solid var(--ao-border)', background: 'transparent', color: 'var(--ao-text-dim)',
            cursor: busy ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <X size={10} /> Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}

function DoneRow({ task, onClick }) {
  const color = AGENT_COLORS[task.assigned_name] || '#64748b'
  return (
    <div onClick={onClick} style={{
      padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8,
      borderLeft: `2px solid ${color}40`, background: 'transparent', borderRadius: 4,
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <CheckCircle2 size={12} style={{ color: '#10b981', flexShrink: 0 }} />
      <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {task.title}
      </span>
      <span style={{ fontSize: 10, opacity: 0.6, color, fontWeight: 500 }}>
        {task.assigned_name}
      </span>
      <span style={{ fontSize: 10, opacity: 0.5, minWidth: 50, textAlign: 'right' }}>
        {fmtDuration(task.duration_min)}
      </span>
      <span style={{ fontSize: 10, opacity: 0.5, minWidth: 54, textAlign: 'right' }}>
        {fmtAgo(task.completed_at)}
      </span>
    </div>
  )
}

function AgentDot({ name, color, active }) {
  return (
    <div style={{
      width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
      background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'white', fontSize: 11, fontWeight: 700,
      boxShadow: active ? `0 0 10px ${color}80` : 'none',
    }}>
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  )
}

function EmptyState({ icon, message, color = 'var(--ao-text-dim)' }) {
  return (
    <div style={{
      padding: '20px 12px', textAlign: 'center', fontSize: 12,
      color, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    }}>
      {icon && <div style={{ opacity: 0.5 }}>{icon}</div>}
      <span>{message}</span>
    </div>
  )
}

// ============================================================
// FORMATTERS
// ============================================================

function fmtMin(m) {
  if (m == null) return '?'
  const n = parseFloat(m)
  if (n < 1) return 'menos de 1min'
  if (n < 60) return `${Math.round(n)}min`
  const h = n / 60
  if (h < 24) return `${h.toFixed(1)}h`
  return `${Math.round(h / 24)}d`
}

function fmtDuration(m) {
  if (m == null) return '—'
  const n = parseFloat(m)
  if (n < 1) return '<1min'
  if (n < 60) return `${Math.round(n)}min`
  return `${(n / 60).toFixed(1)}h`
}

function fmtAgo(iso) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}min`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
