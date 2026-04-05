import { useState, useEffect, useRef } from 'react'

function timeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000)
  if (seconds < 60) return 'agora'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function isToday(date) {
  return new Date(date).toDateString() === new Date().toDateString()
}

function isYesterday(date) {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return new Date(date).toDateString() === d.toDateString()
}

function getDateLabel(date) {
  if (isToday(date)) return 'Hoje'
  if (isYesterday(date)) return 'Ontem'
  return new Date(date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

const statusConfig = {
  blocked: { icon: 'blocked', color: '#ef4444', label: 'Bloqueada' },
  in_progress: { icon: 'progress', color: '#C4956A', label: 'Em andamento' },
  pending: { icon: 'pending', color: '#f59e0b', label: 'Aguardando' },
  done: { icon: 'done', color: '#22c55e', label: 'Concluida' },
  cancelled: { icon: 'cancelled', color: 'var(--ao-text-xs)', label: 'Cancelada' },
}

function StatusIcon({ type, color }) {
  const size = 14
  if (type === 'blocked') return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.2"/>
      <path d="M6 6l4 4" stroke={color} strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  )
  if (type === 'done') return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.2"/>
      <path d="M5.5 8l2 2 3-3" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
  if (type === 'progress') return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.2"/>
      <path d="M8 5v3l2 1" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
  if (type === 'pending') return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.2" strokeDasharray="3 2"/>
    </svg>
  )
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.2"/>
    </svg>
  )
}

export default function ActivityFeed() {
  const [items, setItems] = useState([])
  const [visible, setVisible] = useState(true)
  const prevCountRef = useRef(0)
  const [newItems, setNewItems] = useState(new Set())

  useEffect(() => {
    loadFeed()
    const interval = setInterval(loadFeed, 10000)
    return () => clearInterval(interval)
  }, [])

  async function loadFeed() {
    try {
      const res = await fetch('/api/activity-feed')
      const data = await res.json()
      if (data.length > prevCountRef.current && prevCountRef.current > 0) {
        const newIds = new Set(data.slice(0, data.length - prevCountRef.current).map(t => t.id))
        setNewItems(newIds)
        setTimeout(() => setNewItems(new Set()), 2000)
      }
      prevCountRef.current = data.length
      setItems(data)
    } catch { setItems([]) }
  }

  // Group by date
  const grouped = items.reduce((acc, task) => {
    const label = getDateLabel(task.created_at)
    if (!acc[label]) acc[label] = []
    acc[label].push(task)
    return acc
  }, {})

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <h2 className="section-header">
            {items.length > 0 ? `Atividade (${items.length})` : 'Atividade'}
          </h2>
          {items.filter(t => t.status === 'blocked').length > 0 && (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider"
              style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.08)' }}>
              {items.filter(t => t.status === 'blocked').length} bloqueada{items.filter(t => t.status === 'blocked').length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button onClick={() => setVisible(!visible)}
          className="text-[10px] transition-colors duration-200 px-2 py-1 rounded-md cursor-pointer"
          style={{ color: 'var(--ao-text-xs)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--ao-text-dim)'; e.currentTarget.style.background = 'var(--ao-hover-bg)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ao-text-xs)'; e.currentTarget.style.background = 'transparent' }}>
          {visible ? 'Minimizar' : 'Expandir'}
        </button>
      </div>

      {visible && (
        <div className="glass-card rounded-xl overflow-hidden">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <div className="w-10 h-10 rounded-xl mx-auto mb-2.5 flex items-center justify-center"
                style={{ background: 'rgba(52, 211, 153, 0.06)', border: '1px solid rgba(52, 211, 153, 0.06)' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(52, 211, 153, 0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <p className="text-emerald-400/50 text-[12px] font-medium">Tudo operacional</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--ao-text-xs)' }}>Nenhum alerta ou pendencia no momento</p>
            </div>
          ) : (
            <div>
              {Object.entries(grouped).map(([dateLabel, tasks]) => (
                <div key={dateLabel}>
                  {/* Date header */}
                  <div className="px-4 py-2 flex items-center gap-2" style={{ background: 'var(--ao-hover-bg)' }}>
                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ao-text-xs)' }}>{dateLabel}</span>
                    <div className="flex-1 h-px" style={{ background: 'var(--ao-separator)' }} />
                    <span className="text-[10px]" style={{ color: 'var(--ao-text-xs)' }}>{tasks.length}</span>
                  </div>

                  {/* Tasks */}
                  {tasks.map((task, index) => {
                    const st = statusConfig[task.status] || statusConfig.pending
                    const isNew = newItems.has(task.id)
                    const isNfse = task.title?.includes('[NFSE]') || task.title?.includes('[FISCAL]')
                    const cleanTitle = task.title?.replace(/\[NFSE\]\s*|^\[FISCAL\]\s*/g, '').trim()
                    const priorityColor = task.status === 'blocked' ? '#EF4444'
                      : task.priority === 'urgent' ? '#EF4444'
                      : task.priority === 'high' ? '#F59E0B'
                      : '#C4956A'

                    return (
                      <div
                        key={task.id}
                        className={`flex items-center gap-3 px-4 py-2.5 transition-all duration-500 stagger-item ${isNew ? 'animate-message-glow' : ''}`}
                        style={{
                          borderBottom: `1px solid var(--ao-separator)`,
                          animationDelay: `${index * 40}ms`,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ao-hover-bg)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <StatusIcon type={st.icon} color={st.color} />

                        <div className="w-0.5 h-5 rounded-full shrink-0" style={{ backgroundColor: `${priorityColor}30` }} />

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {isNfse && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wider"
                                style={{ background: '#C4956A10', color: '#C4956A80', border: '1px solid #C4956A10' }}>
                                NFS-e
                              </span>
                            )}
                            <p className="text-[12px] truncate" style={{ color: 'var(--ao-text-secondary)' }}>{cleanTitle}</p>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] font-medium" style={{ color: st.color }}>{st.label}</span>
                            {task.assigned_name && <span className="text-[10px]" style={{ color: 'var(--ao-text-xs)' }}>{'\u2192'} {task.assigned_name}</span>}
                            {task.client_name && <span className="text-[10px]" style={{ color: 'var(--ao-text-xs)' }}>{'\u2022'} {task.client_name}</span>}
                          </div>
                        </div>

                        <span className="text-[10px] tabular-nums shrink-0" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-xs)' }}>
                          {timeAgo(task.created_at)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
