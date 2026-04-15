import { useState, useEffect, useRef } from 'react'

const TYPE_CONFIG = {
  task_complete: { icon: '\u2705', color: '#22c55e', label: 'Tarefa concluida' },
  escalation: { icon: '\u{1F6A8}', color: '#f87171', label: 'Escalacao' },
  prazo_fiscal: { icon: '\u{1F4C5}', color: '#fbbf24', label: 'Prazo fiscal' },
  erro_servico: { icon: '\u26A0\uFE0F', color: '#f87171', label: 'Erro de servico' },
  info: { icon: '\u2139\uFE0F', color: '#60a5fa', label: 'Informacao' },
}

function timeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000)
  if (seconds < 60) return 'agora'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export default function NotificationDropdown() {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const ref = useRef(null)

  const fetchNotifications = async () => {
    try {
      const res = await fetch('/api/notifications?limit=30')
      const data = await res.json()
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch (e) { console.error('Notifications fetch error:', e) }
  }

  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 30000)
    return () => clearInterval(interval)
  }, [])

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const markRead = async (id) => {
    await fetch(`/api/notifications/${id}`, { method: 'PATCH' })
    fetchNotifications()
  }

  const markAllRead = async () => {
    await fetch('/api/notifications/read-all', { method: 'PATCH' })
    fetchNotifications()
  }

  const clearRead = async () => {
    await fetch('/api/notifications/read', { method: 'DELETE' })
    fetchNotifications()
  }

  return (
    <div ref={ref} className="relative">
      {/* Bell button */}
      <button onClick={() => setOpen(!open)}
        className="relative flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 cursor-pointer"
        style={{
          background: open ? 'rgba(196,149,106,0.15)' : 'var(--ao-input-bg)',
          border: `1px solid ${open ? 'rgba(196,149,106,0.3)' : 'var(--ao-border)'}`,
          color: open ? '#C4956A' : 'var(--ao-text-muted)',
        }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/>
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full text-[9px] font-bold text-white px-1"
            style={{ background: '#C4956A', boxShadow: '0 0 8px rgba(196,149,106,0.4)', fontFamily: 'Space Grotesk' }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-11 w-[380px] rounded-xl overflow-hidden z-50"
          style={{
            background: 'var(--ao-popup-bg)',
            border: '1px solid var(--ao-border)',
            boxShadow: '0 24px 60px var(--ao-shadow), 0 8px 24px var(--ao-shadow), 0 0 0 1px rgba(196,149,106,0.08)',
            backdropFilter: 'blur(16px)',
          }}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--ao-border)' }}>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--ao-text-primary)', fontFamily: 'Outfit' }}>
              Notificacoes
            </span>
            <div className="flex gap-2">
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="text-[10px] font-medium px-2 py-1 rounded-md transition-colors cursor-pointer"
                  style={{ color: '#C4956A', background: 'rgba(196,149,106,0.12)', border: '1px solid rgba(196,149,106,0.2)' }}>
                  Marcar todas lidas
                </button>
              )}
              <button onClick={clearRead} className="text-[10px] font-medium px-2 py-1 rounded-md transition-colors cursor-pointer"
                style={{ color: 'var(--ao-text-secondary)', background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border)' }}>
                Limpar
              </button>
            </div>
          </div>

          {/* List */}
          <div className="max-h-[400px] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
            {notifications.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12px]" style={{ color: 'var(--ao-text-dim)' }}>
                <div className="text-[24px] mb-2">{'\u{1F514}'}</div>
                Sem notificacoes
              </div>
            ) : notifications.map(n => {
              const cfg = TYPE_CONFIG[n.type] || TYPE_CONFIG.info
              return (
                <button key={n.id}
                  className="w-full flex items-start gap-3 px-4 py-3 text-left transition-all duration-150 cursor-pointer"
                  style={{
                    background: n.read ? 'transparent' : 'rgba(196,149,106,0.08)',
                    borderBottom: '1px solid var(--ao-separator)',
                    borderLeft: n.read ? '3px solid transparent' : `3px solid ${cfg.color}`,
                  }}
                  onClick={() => !n.read && markRead(n.id)}
                >
                  <span className="text-[16px] mt-0.5 shrink-0">{cfg.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold truncate" style={{ color: n.read ? 'var(--ao-text-muted)' : 'var(--ao-text-primary)' }}>
                        {n.title}
                      </span>
                      {!n.read && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#C4956A' }} />}
                    </div>
                    {n.message && (
                      <div className="text-[11px] mt-0.5 line-clamp-2" style={{ color: 'var(--ao-text-dim)' }}>
                        {n.message}
                      </div>
                    )}
                    <div className="text-[10px] mt-1" style={{ color: 'var(--ao-text-dim)', fontFamily: 'Space Grotesk' }}>
                      {timeAgo(n.created_at)}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
