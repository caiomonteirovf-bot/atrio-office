import { useState, useEffect, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'

const SEVERITY_CONFIG = {
  normal: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.06)', border: 'rgba(245, 158, 11, 0.08)', label: 'Normal' },
  atencao: { color: '#f97316', bg: 'rgba(249, 115, 22, 0.06)', border: 'rgba(249, 115, 22, 0.08)', label: 'Atencao' },
  critico: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.06)', border: 'rgba(239, 68, 68, 0.08)', label: 'Critico' },
  urgente: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.12)', label: 'Urgente' },
  grave: { color: '#dc2626', bg: 'rgba(220, 38, 38, 0.08)', border: 'rgba(220, 38, 38, 0.12)', label: 'Grave' },
}

const WS_REFRESH_EVENTS = new Set([
  'whatsapp_message', 'whatsapp_new_contact', 'whatsapp_classification',
  'whatsapp_escalation', 'whatsapp_ready', 'whatsapp_disconnected',
  'whatsapp_conversation_analysis', 'whatsapp_resolved',
])

function timeSince(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)}min`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`
  return `${Math.floor(s / 86400)}d`
}

function ClientAvatar({ name }) {
  const initials = name ? name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() : '?'
  return (
    <div className="w-9 h-9 rounded-xl flex items-center justify-center text-[11px] font-bold shrink-0"
      style={{ background: 'rgba(196, 149, 106, 0.08)', color: 'rgba(196, 149, 106, 0.5)', border: '1px solid rgba(196, 149, 106, 0.08)' }}>
      {initials}
    </div>
  )
}

export default function AttendanceQueue() {
  const [queue, setQueue] = useState([])
  const [wsStatus, setWsStatus] = useState(null)
  const [, setTick] = useState(0)
  const [actionLoading, setActionLoading] = useState(null)
  const { lastMessage } = useWebSocket()
  const loadRef = useRef(null)

  async function load() {
    try {
      const [pending, status] = await Promise.all([
        fetch('/api/whatsapp/pending').then(r => r.json()),
        fetch('/api/whatsapp/status').then(r => r.json()),
      ])
      setQueue(pending)
      setWsStatus(status)
    } catch {}
  }

  // Initial load + polling fallback (30s)
  useEffect(() => {
    load()
    const dataInterval = setInterval(load, 30000)
    const tickInterval = setInterval(() => setTick(t => t + 1), 1000)
    return () => { clearInterval(dataInterval); clearInterval(tickInterval) }
  }, [])

  // WebSocket: refresh immediately on relevant events
  useEffect(() => {
    if (lastMessage && WS_REFRESH_EVENTS.has(lastMessage.type)) {
      // Debounce rapid events (e.g. multiple messages in quick succession)
      clearTimeout(loadRef.current)
      loadRef.current = setTimeout(load, 500)
    }
  }, [lastMessage])

  async function handleMarkReplied(phone) {
    setActionLoading(phone)
    try {
      await fetch(`/api/whatsapp/mark-replied/${encodeURIComponent(phone)}`, { method: 'POST' })
      await load()
    } catch {}
    setActionLoading(null)
  }

  async function handleResolve(phone) {
    setActionLoading(phone)
    try {
      await fetch(`/api/whatsapp/conversations/${encodeURIComponent(phone)}/resolve`, { method: 'POST' })
      await load()
    } catch {}
    setActionLoading(null)
  }

  if (!wsStatus?.connected) {
    return (
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full bg-red-400/60" />
          <span className="text-[12px]" style={{ color: 'var(--ao-text-dim)' }}>WhatsApp desconectado</span>
        </div>
      </div>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="section-header">Atendimento WhatsApp</h2>
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full" style={{ background: 'rgba(52, 211, 153, 0.06)', border: '1px solid rgba(52, 211, 153, 0.08)' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(52,211,153,0.4)' }} />
            <span className="text-[10px] text-emerald-400/70 font-medium">Luna ativa</span>
          </div>
        </div>
        {queue.length > 0 && (
          <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
            style={{ background: 'rgba(245, 158, 11, 0.08)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.1)' }}>
            {queue.length} aguardando
          </span>
        )}
      </div>

      {queue.length === 0 ? (
        <div className="glass-card rounded-xl p-6 text-center">
          <div className="w-10 h-10 rounded-xl mx-auto mb-2.5 flex items-center justify-center"
            style={{ background: 'rgba(52, 211, 153, 0.06)', border: '1px solid rgba(52, 211, 153, 0.06)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(52, 211, 153, 0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <p className="text-[12px] font-medium" style={{ color: 'var(--ao-text-dim)' }}>Nenhum atendimento pendente</p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--ao-text-xs)' }}>Quando clientes mandarem mensagem, aparecerao aqui</p>
        </div>
      ) : (
        <div className="space-y-2">
          {queue.map((item, index) => {
            const sev = SEVERITY_CONFIG[item.severity] || SEVERITY_CONFIG.normal
            const waitTime = timeSince(item.receivedAt)
            const isUrgent = item.severity === 'critico' || item.severity === 'urgente' || item.severity === 'grave'
            const isLoading = actionLoading === item.phone

            return (
              <div
                key={item.phone}
                className="glass-card rounded-xl p-3.5 relative overflow-hidden stagger-item"
                style={{
                  background: sev.bg,
                  borderColor: sev.border,
                  animationDelay: `${index * 60}ms`,
                }}
              >
                <div className="flex items-start gap-3">
                  <ClientAvatar name={item.name} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-bold" style={{ fontFamily: 'Outfit', color: 'var(--ao-text-primary)' }}>{item.name}</h3>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wider"
                        style={{ background: `${sev.color}15`, color: sev.color, border: `1px solid ${sev.color}15` }}>
                        {sev.label}
                      </span>
                      {item.humanReplied && (
                        <span className="text-[9px] text-amber-400/70 font-medium px-1.5 py-0.5 rounded bg-amber-500/10">Insistiu</span>
                      )}
                    </div>
                    <p className="text-[11px] mt-0.5" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-xs)' }}>{item.phone}</p>
                    <p className="text-[11px] mt-1.5 italic line-clamp-1" style={{ color: 'var(--ao-text-dim)' }}>
                      &ldquo;{item.lastMessage?.substring(0, 80)}&rdquo;
                    </p>
                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => handleMarkReplied(item.phone)}
                        disabled={isLoading}
                        className="text-[10px] font-medium px-2.5 py-1 rounded-lg transition-colors"
                        style={{ background: 'rgba(52, 211, 153, 0.08)', color: 'rgba(52, 211, 153, 0.7)', border: '1px solid rgba(52, 211, 153, 0.1)' }}
                      >
                        {isLoading ? '...' : 'Respondido'}
                      </button>
                      <button
                        onClick={() => handleResolve(item.phone)}
                        disabled={isLoading}
                        className="text-[10px] font-medium px-2.5 py-1 rounded-lg transition-colors"
                        style={{ background: 'rgba(196, 149, 106, 0.08)', color: 'rgba(196, 149, 106, 0.6)', border: '1px solid rgba(196, 149, 106, 0.1)' }}
                      >
                        {isLoading ? '...' : 'Resolver'}
                      </button>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`text-[12px] tabular-nums font-semibold ${isUrgent ? 'text-red-400' : ''}`}
                      style={{ fontFamily: 'Space Grotesk', color: isUrgent ? undefined : 'var(--ao-text-dim)' }}>
                      {waitTime}
                    </span>
                  </div>
                </div>

                {/* Urgency bar */}
                {isUrgent && (
                  <div className="absolute bottom-0 left-0 right-0 vista-bar-agent" style={{ '--agent-color': sev.color }} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
