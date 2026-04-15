import { useState, useEffect } from 'react'

const SERVICES = [
  { key: 'postgres', label: 'PostgreSQL', icon: '\u{1F5C4}\uFE0F' },
  { key: 'whatsapp', label: 'WhatsApp', icon: '\u{1F4AC}' },
  { key: 'agents', label: 'Agentes', icon: '\u{1F916}' },
]

const STATUS_COLORS = {
  ok: '#22c55e',
  degraded: '#fbbf24',
  error: '#f87171',
  disconnected: '#f87171',
  unknown: 'rgba(255,255,255,0.25)',
}

export default function StatusBar() {
  const [health, setHealth] = useState(null)

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/health')
        const data = await res.json()
        setHealth(data)
      } catch (e) {
        setHealth({ status: 'error', services: {} })
      }
    }
    check()
    const interval = setInterval(check, 30000)
    return () => clearInterval(interval)
  }, [])

  if (!health) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 h-7 flex items-center justify-between px-4 z-40 select-none"
      style={{
        background: 'linear-gradient(180deg, rgba(15,17,23,0.95) 0%, rgba(8,8,10,0.98) 100%)',
        borderTop: '1px solid rgba(255,255,255,0.04)',
        backdropFilter: 'blur(12px)',
      }}>

      {/* Left: Services */}
      <div className="flex items-center gap-4">
        {SERVICES.map(svc => {
          const svcHealth = health.services?.[svc.key] || {}
          const color = STATUS_COLORS[svcHealth.status] || STATUS_COLORS.unknown
          const isDown = svcHealth.status === 'error' || svcHealth.status === 'disconnected'
          return (
            <div key={svc.key} className="flex items-center gap-1.5" title={`${svc.label}: ${svcHealth.status || 'unknown'}${svcHealth.latency ? ` (${svcHealth.latency}ms)` : ''}`}>
              <span className={`w-[6px] h-[6px] rounded-full ${isDown ? 'animate-pulse' : ''}`}
                style={{ background: color, boxShadow: isDown ? `0 0 8px ${color}` : 'none' }} />
              <span className="text-[10px]" style={{ color: 'var(--ao-text-dim)', fontFamily: 'Space Grotesk' }}>
                {svc.label}
              </span>
              {svcHealth.latency && (
                <span className="text-[9px]" style={{ color: 'var(--ao-text-xs, rgba(255,255,255,0.2))', fontFamily: 'Space Grotesk' }}>
                  {svcHealth.latency}ms
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Right: Overall status */}
      <div className="flex items-center gap-3">
        <span className="text-[10px]" style={{
          color: health.status === 'ok' ? '#22c55e' : '#fbbf24',
          fontFamily: 'Space Grotesk',
          fontWeight: 600,
        }}>
          {health.status === 'ok' ? '\u25CF TUDO OPERACIONAL' : '\u25CF COM INSTABILIDADE'}
        </span>
      </div>
    </div>
  )
}
