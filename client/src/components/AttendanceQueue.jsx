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

function WhatsAppConnect({ wsStatus, onConnected }) {
  const [qrData, setQrData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const pollRef = useRef(null)
  const { lastMessage } = useWebSocket()

  // Listen for WebSocket events: QR generated or connected
  useEffect(() => {
    if (lastMessage?.type === 'whatsapp_qr') {
      // QR was generated, fetch it
      fetch('/api/whatsapp/qr').then(r => r.json()).then(data => {
        if (data.hasQR) setQrData(data.qr)
      }).catch(() => {})
    }
    if (lastMessage?.type === 'whatsapp_ready') {
      setQrData(null)
      setPolling(false)
      clearInterval(pollRef.current)
      onConnected?.()
    }
  }, [lastMessage, onConnected])

  // Poll for QR while waiting
  useEffect(() => {
    if (!polling) return
    pollRef.current = setInterval(async () => {
      try {
        const [statusRes, qrRes] = await Promise.all([
          fetch('/api/whatsapp/status').then(r => r.json()),
          fetch('/api/whatsapp/qr').then(r => r.json()),
        ])
        if (statusRes.connected) {
          setQrData(null)
          setPolling(false)
          clearInterval(pollRef.current)
          onConnected?.()
          return
        }
        if (qrRes.hasQR) setQrData(qrRes.qr)
      } catch {}
    }, 3000)
    return () => clearInterval(pollRef.current)
  }, [polling, onConnected])

  async function handleConnect() {
    setLoading(true)
    try {
      // First check if QR is already available
      const res = await fetch('/api/whatsapp/qr').then(r => r.json())
      if (res.hasQR) {
        setQrData(res.qr)
      }
      // Start polling for QR / connection
      setPolling(true)
    } catch {}
    setLoading(false)
  }

  return (
    <div className="glass-card rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.08)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(239, 68, 68, 0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>
          </svg>
        </div>
        <div className="flex-1">
          <span className="text-[13px] font-semibold" style={{ fontFamily: 'Outfit', color: 'var(--ao-text-primary)' }}>WhatsApp desconectado</span>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--ao-text-xs)' }}>
            {qrData ? 'Escaneie o QR code no WhatsApp do escritorio' : 'Clique para gerar o QR code e conectar'}
          </p>
        </div>
        {!qrData && (
          <button
            onClick={handleConnect}
            disabled={loading || polling}
            className="text-[11px] font-medium px-3.5 py-1.5 rounded-lg transition-colors cursor-pointer"
            style={{ background: 'rgba(52, 211, 153, 0.08)', color: 'rgba(52, 211, 153, 0.8)', border: '1px solid rgba(52, 211, 153, 0.12)' }}>
            {loading || polling ? 'Aguardando QR...' : 'Conectar'}
          </button>
        )}
      </div>

      {qrData && (
        <div className="flex flex-col items-center gap-3 pt-2">
          <div className="rounded-xl p-3" style={{ background: '#ffffff' }}>
            <img src={qrData} alt="WhatsApp QR Code" className="w-48 h-48" />
          </div>
          <p className="text-[10px] text-center" style={{ color: 'var(--ao-text-dim)' }}>
            Abra o WhatsApp no celular &rarr; Aparelhos conectados &rarr; Conectar aparelho
          </p>
          {polling && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-[10px]" style={{ color: 'var(--ao-text-xs)' }}>Aguardando leitura do QR...</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function AttendanceQueue() {
  const [queue, setQueue] = useState([])
  const [wsStatus, setWsStatus] = useState(null)
  const [, setTick] = useState(0)
  const [actionLoading, setActionLoading] = useState(null)
  const [showWsMenu, setShowWsMenu] = useState(false)
  const [wsActionLoading, setWsActionLoading] = useState(false)
  const { lastMessage } = useWebSocket()
  const loadRef = useRef(null)
  const menuRef = useRef(null)

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
      clearTimeout(loadRef.current)
      loadRef.current = setTimeout(load, 500)
    }
  }, [lastMessage])

  // Close menu on click outside
  useEffect(() => {
    if (!showWsMenu) return
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowWsMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showWsMenu])

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

  async function handleDisconnect() {
    setWsActionLoading(true)
    try {
      await fetch('/api/whatsapp/disconnect', { method: 'POST' })
      await load()
    } catch {}
    setWsActionLoading(false)
    setShowWsMenu(false)
  }

  async function handleReconnect() {
    setWsActionLoading(true)
    try {
      await fetch('/api/whatsapp/reconnect', { method: 'POST' })
      // Poll for reconnection
      const poll = setInterval(async () => {
        const status = await fetch('/api/whatsapp/status').then(r => r.json())
        if (status.connected) {
          clearInterval(poll)
          setWsActionLoading(false)
          setShowWsMenu(false)
          await load()
        }
      }, 3000)
      // Timeout after 60s
      setTimeout(() => { clearInterval(poll); setWsActionLoading(false) }, 60000)
    } catch {
      setWsActionLoading(false)
    }
  }

  if (!wsStatus?.connected) {
    return <WhatsAppConnect wsStatus={wsStatus} onConnected={load} />
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="section-header">Atendimento WhatsApp</h2>
          {/* Connection status badge with menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowWsMenu(v => !v)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full cursor-pointer transition-all"
              style={{
                background: 'rgba(52, 211, 153, 0.06)',
                border: `1px solid ${showWsMenu ? 'rgba(52, 211, 153, 0.2)' : 'rgba(52, 211, 153, 0.08)'}`,
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(52,211,153,0.4)' }} />
              <span className="text-[10px] text-emerald-400/70 font-medium">
                Luna ativa{wsStatus?.phone ? ` \u00B7 ${wsStatus.phone}` : ''}
              </span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`transition-transform ${showWsMenu ? 'rotate-180' : ''}`}>
                <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="rgba(52,211,153,0.5)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {showWsMenu && (
              <div className="absolute top-full left-0 mt-1.5 py-1.5 rounded-xl z-20 min-w-[180px]"
                style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border-hover)', boxShadow: '0 8px 24px var(--ao-shadow)' }}>
                {/* Status info */}
                <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--ao-border-subtle)' }}>
                  <p className="text-[10px] font-medium" style={{ color: 'var(--ao-text-dim)' }}>Conexao WhatsApp</p>
                  {wsStatus?.phone && (
                    <p className="text-[11px] font-semibold mt-0.5" style={{ color: 'var(--ao-text-secondary)' }}>+{wsStatus.phone}</p>
                  )}
                  <p className="text-[9px] mt-0.5" style={{ color: 'var(--ao-text-xs)' }}>
                    {wsStatus?.activeConversations || 0} conversas ativas
                  </p>
                </div>

                {/* Reconnect */}
                <button
                  onClick={handleReconnect}
                  disabled={wsActionLoading}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(52,211,153,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                  </svg>
                  <span className="text-[11px]" style={{ color: 'var(--ao-text-secondary)' }}>
                    {wsActionLoading ? 'Reconectando...' : 'Reconectar'}
                  </span>
                </button>

                {/* Disconnect */}
                <button
                  onClick={handleDisconnect}
                  disabled={wsActionLoading}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(239,68,68,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18.36 6.64a9 9 0 11-12.73 0"/>
                    <line x1="12" y1="2" x2="12" y2="12"/>
                  </svg>
                  <span className="text-[11px]" style={{ color: 'rgba(239,68,68,0.7)' }}>
                    {wsActionLoading ? 'Desconectando...' : 'Desconectar'}
                  </span>
                </button>
              </div>
            )}
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
