import { useState, useEffect, useContext } from 'react'
import { ThemeContext } from '../App'

const LINKS = [
  { label: 'Escritorio', type: 'internal', id: 'home' },
  { label: 'Gesthub', type: 'external', url: 'https://gesthub-xlvb.onrender.com' },
  // { label: 'Banking', type: 'external', url: '' }, // Não deployado na VPS ainda
  { label: 'NFS-e System', type: 'external', url: 'http://31.97.175.200:3020' },
  { label: 'Relatorio', type: 'action', id: 'relatorio' },
]

export default function TopBar({ agents, connected, onAction }) {
  const { theme, toggle: toggleTheme } = useContext(ThemeContext)
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const onlineCount = agents?.filter(a => a.status === 'online').length || 0

  function handleClick(link) {
    if (link.type === 'external') {
      window.open(link.url, '_blank', 'noopener')
    } else if (link.type === 'action') {
      onAction?.(link.id)
    }
  }

  return (
    <div className="relative flex items-center h-[52px] shrink-0" style={{
      background: `linear-gradient(180deg, var(--ao-topbar) 0%, var(--ao-topbar) 100%)`,
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      borderBottom: `1px solid var(--ao-border)`,
      transition: 'background 0.3s',
    }}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 h-full" style={{ borderRight: `1px solid var(--ao-border)` }}>
        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{
          background: 'linear-gradient(135deg, #C4956A 0%, #A67B52 100%)',
          boxShadow: '0 2px 12px rgba(196, 149, 106, 0.25)',
        }}>
          <span className="text-white text-[12px] font-black tracking-tight">A</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-[16px] font-bold tracking-tight" style={{ fontFamily: 'Outfit', color: 'var(--ao-text)' }}>Atrio</span>
          <span className="text-[#C4956A] text-[16px] font-bold tracking-tight" style={{ fontFamily: 'Outfit' }}>Office</span>
        </div>
      </div>

      {/* Links */}
      <div className="flex items-center h-full flex-1">
        {LINKS.map(link => (
          <button
            key={link.label}
            onClick={() => handleClick(link)}
            className="relative flex items-center gap-1.5 h-full px-4 text-[12.5px] font-medium transition-all duration-200 cursor-pointer"
            style={{ color: link.type === 'internal' ? 'var(--ao-text-primary)' : 'var(--ao-text-dim)' }}
            onMouseEnter={(e) => { if (link.type !== 'internal') e.target.style.color = 'var(--ao-text-secondary)' }}
            onMouseLeave={(e) => { if (link.type !== 'internal') e.target.style.color = 'var(--ao-text-dim)' }}
          >
            {link.label}
            {link.type === 'external' && (
              <svg className="w-3 h-3 opacity-40" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4.5 1.5H2a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V7.5M7 1.5h3.5V5M6 6l4.5-4.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {link.type === 'internal' && (
              <span className="absolute bottom-0 left-4 right-4 h-[2px] rounded-t-full" style={{
                background: 'linear-gradient(90deg, #C4956A, #C4956A80)',
                boxShadow: '0 0 8px rgba(196, 149, 106, 0.3)',
              }} />
            )}
          </button>
        ))}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-5 px-5 h-full" style={{ borderLeft: `1px solid var(--ao-border)` }}>
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Modo claro' : 'Modo escuro'}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 cursor-pointer"
          style={{
            background: 'var(--ao-input-bg)',
            border: `1px solid var(--ao-border)`,
            color: 'var(--ao-text-muted)',
          }}
        >
          {theme === 'dark' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>

        {/* Connection status */}
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full transition-all duration-500 ${connected ? 'bg-emerald-400' : 'bg-red-400'}`}
            style={connected ? { boxShadow: '0 0 8px rgba(52, 211, 153, 0.5)' } : {}} />
          <span className="text-[11px] tabular-nums" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-dim)' }}>
            {onlineCount} agentes
          </span>
        </div>

        {/* Time */}
        <div className="flex flex-col items-end">
          <span className="text-[13px] tabular-nums font-medium" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-muted)' }}>
            {time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="text-[9px] tabular-nums" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-xs)' }}>
            {time.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}
          </span>
        </div>
      </div>

      {/* Bottom gradient line */}
      {connected && (
        <div className="absolute bottom-0 left-0 right-0 vista-bar" />
      )}
    </div>
  )
}
