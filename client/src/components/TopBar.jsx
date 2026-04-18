import { useState, useEffect, useContext, useRef } from 'react'
import { ThemeContext } from '../App'
import NotificationDropdown from './NotificationDropdown'

const INTERNAL = [
  { label: 'Escritorio', id: 'home' },
  { label: 'Rotinas', id: 'crons' },
  { label: 'Calendário', id: 'calendar' },
  { label: 'Memória', id: 'memory' },
  { label: 'Documentos', id: 'docs' },
  { label: 'Auditoria', id: 'activity' },
  { label: 'Alertas', id: 'alerts' },
  { label: 'Erros', id: 'errors' },
  { label: 'Datalake', id: 'datalake' },
]
const SISTEMAS = [
  { label: 'Gesthub',      url: 'http://31.97.175.200' },
  { label: 'Banking',      url: 'http://31.97.175.200:3000' },
  { label: 'NFS-e System', url: 'http://31.97.175.200:3020' },
]
const ACTIONS = [ // desativado temporariamente - sem uso
  // { label: 'Relatorio', id: 'relatorio' }, // desabilitado
]

export default function TopBar({ agents, connected, onAction, onSearchOpen, currentPage, onNavigate }) {
  const { theme, toggle: toggleTheme } = useContext(ThemeContext)
  const [time, setTime] = useState(new Date())
  const [sistOpen, setSistOpen] = useState(false)
  const sistRef = useRef(null)

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    function onDocClick(e) { if (sistRef.current && !sistRef.current.contains(e.target)) setSistOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const onlineCount = agents?.filter(a => a.status === 'online').length || 0

  return (
    <div className="relative flex items-center h-[52px] shrink-0 z-[100]" style={{
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
        {INTERNAL.map(link => {
          const active = currentPage === link.id
          return (
            <button
              key={link.id}
              onClick={() => onNavigate?.(link.id)}
              className="relative flex items-center gap-1.5 h-full px-4 text-[12.5px] font-medium transition-all duration-200 cursor-pointer"
              style={{ color: active ? 'var(--ao-text-primary)' : 'var(--ao-text-secondary)' }}
            >
              {link.label}
              {active && (
                <span className="absolute bottom-0 left-4 right-4 h-[2px] rounded-t-full" style={{
                  background: 'linear-gradient(90deg, #C4956A, #C4956A80)',
                  boxShadow: '0 0 8px rgba(196, 149, 106, 0.3)',
                }} />
              )}
            </button>
          )
        })}

        {/* Sistemas dropdown */}
        <div className="relative h-full" ref={sistRef}>
          <button
            onClick={() => setSistOpen(v => !v)}
            className="flex items-center gap-1.5 h-full px-4 text-[12.5px] font-medium cursor-pointer"
            style={{ color: sistOpen ? 'var(--ao-text-primary)' : 'var(--ao-text-dim)' }}
          >
            Sistemas
            <svg className="w-3 h-3 opacity-60" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 4.5l3 3 3-3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {sistOpen && (
            <div className="absolute top-full left-2 mt-1 min-w-[200px] rounded-lg overflow-hidden z-[9999]"
              style={{ background:'#0f1115', backgroundColor:'#0f1115', border:'1px solid var(--ao-border)', boxShadow:'0 16px 48px rgba(0,0,0,0.85)' }}>
              {SISTEMAS.map(s => (
                <button key={s.label}
                  onClick={() => { window.open(s.url, '_blank', 'noopener'); setSistOpen(false) }}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-left text-[12.5px] hover:bg-white/5 transition-colors"
                  style={{ color:'var(--ao-text-secondary)' }}
                >
                  <span>{s.label}</span>
                  <svg className="w-3 h-3 opacity-50" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4.5 1.5H2a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V7.5M7 1.5h3.5V5M6 6l4.5-4.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              ))}
            </div>
          )}
        </div>

        {ACTIONS.map(a => (
          <button key={a.id}
            onClick={() => onAction?.(a.id)}
            className="flex items-center gap-1.5 h-full px-4 text-[12.5px] font-medium cursor-pointer"
            style={{ color: 'var(--ao-text-dim)' }}>
            {a.label}
          </button>
        ))}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3 px-5 h-full" style={{ borderLeft: `1px solid var(--ao-border)` }}>
        <button
          onClick={onSearchOpen}
          title="Busca global (Ctrl+K)"
          className="flex items-center gap-2 h-8 px-3 rounded-lg transition-all duration-200 cursor-pointer"
          style={{
            background: 'var(--ao-input-bg)',
            border: '1px solid var(--ao-border)',
            color: 'var(--ao-text-dim)',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span className="text-[11px]" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-dim)' }}>Ctrl+K</span>
        </button>

        <NotificationDropdown />

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

        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full transition-all duration-500 ${connected ? 'bg-emerald-400' : 'bg-red-400'}`}
            style={connected ? { boxShadow: '0 0 8px rgba(52, 211, 153, 0.5)' } : {}} />
          <span className="text-[11px] tabular-nums" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-dim)' }}>
            {onlineCount} agentes
          </span>
        </div>

        <div className="flex flex-col items-end">
          <span className="text-[13px] tabular-nums font-medium" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-muted)' }}>
            {time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="text-[9px] tabular-nums" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-xs)' }}>
            {time.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}
          </span>
        </div>
      </div>

      {connected && (
        <div className="absolute bottom-0 left-0 right-0 vista-bar" />
      )}
    </div>
  )
}
