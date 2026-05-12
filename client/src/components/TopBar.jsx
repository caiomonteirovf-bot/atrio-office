import { useState, useEffect, useContext, useRef } from 'react'
import {
  Home, MessageSquare, Grid3X3, Clock, Calendar, Brain, FileText,
  Shield, AlertTriangle, AlertCircle, Database, ExternalLink, Lock, TrendingUp,
} from 'lucide-react'
import { ThemeContext } from '../App'
import NotificationDropdown from './NotificationDropdown'
import usePushNotifications from '../hooks/usePushNotifications.js'
import { Bell, BellOff } from 'lucide-react'

const INTERNAL = [
  { label: 'Escritorio', id: 'home', Icon: Home, group: 'principal' },
  { label: 'Atendimento', id: 'atendimento', Icon: MessageSquare, group: 'principal' },
  { label: 'Ecossistema', id: 'ecossistema', Icon: Grid3X3, group: 'principal' },
  { label: 'Rotinas', id: 'crons', Icon: Clock, group: 'operacao' },
  { label: 'Calendário', id: 'calendar', Icon: Calendar, group: 'operacao' },
  { label: 'Documentos', id: 'docs', Icon: FileText, group: 'operacao' },
  { label: 'Templates', id: 'templates', Icon: FileText, group: 'operacao' },
  { label: 'Growth', id: 'growth', Icon: TrendingUp, group: 'operacao' },
  { label: 'Memória', id: 'memory', Icon: Brain, group: 'gestao' },
  { label: 'Auditoria', id: 'activity', Icon: Shield, group: 'gestao' },
  { label: 'Alertas', id: 'alerts', Icon: AlertTriangle, group: 'gestao' },
  { label: 'Erros', id: 'errors', Icon: AlertCircle, group: 'gestao' },
  { label: 'Datalake', id: 'datalake', Icon: Database, group: 'gestao' },
  { label: 'Segurança', id: 'seguranca', Icon: Shield, group: 'gestao' },
]
const SISTEMAS = [
  { label: 'Gesthub',      url: 'http://31.97.175.200' },
  { label: "Átrio Finance", url: 'http://31.97.175.200:3000' },
  { label: 'NFS-e System', url: 'http://31.97.175.200:3020' },
]
const ACTIONS = [ // desativado temporariamente - sem uso
  // { label: 'Relatorio', id: 'relatorio' }, // desabilitado
]

export default function TopBar({ agents, connected, onAction, onSearchOpen, currentPage, onNavigate, mobileMenuOpen: externalOpen, setMobileMenuOpen: externalSet }) {
  const { theme, toggle: toggleTheme } = useContext(ThemeContext)
  const [time, setTime] = useState(new Date())
  const [sistOpen, setSistOpen] = useState(false)
  // Permite que o App (via BottomNav) controle abrir/fechar. Fallback pra estado local.
  const [internalOpen, setInternalOpen] = useState(false)
  const mobileMenuOpen = externalOpen !== undefined ? externalOpen : internalOpen
  const setMobileMenuOpen = externalSet || setInternalOpen
  const sistRef = useRef(null)

  // Fecha o drawer mobile ao trocar de pagina
  useEffect(() => { setMobileMenuOpen(false) }, [currentPage])

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

  const activeLabel = INTERNAL.find(l => l.id === currentPage)?.label || 'Escritório'

  return (
    <div className="topbar relative flex items-center h-[52px] shrink-0 z-[100]" style={{
      background: `linear-gradient(180deg, var(--ao-topbar) 0%, var(--ao-topbar) 100%)`,
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      borderBottom: `1px solid var(--ao-border)`,
      transition: 'background 0.3s',
    }}>
      {/* Hamburger (mobile only — escondido em desktop via CSS .topbar-hamburger) */}
      <button
        className="topbar-hamburger"
        onClick={() => setMobileMenuOpen(true)}
        aria-label="Abrir menu"
        style={{
          display: 'none', /* CSS media query liga em <768px */
          alignItems: 'center', justifyContent: 'center',
          width: 44, height: '100%',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ao-text-primary)',
          borderRight: '1px solid var(--ao-border)',
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>

      {/* Logo */}
      <div className="topbar-logo flex items-center gap-3 px-5 h-full" style={{ borderRight: `1px solid var(--ao-border)` }}>
        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{
          background: 'linear-gradient(135deg, #6366F1 0%, #A67B52 100%)',
          boxShadow: '0 2px 12px rgba(99, 102, 241, 0.25)',
        }}>
          <span className="text-white text-[12px] font-black tracking-tight">A</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-[16px] font-bold tracking-tight" style={{ fontFamily: 'Outfit', color: 'var(--ao-text)' }}>Atrio</span>
          <span className="text-[#6366F1] text-[16px] font-bold tracking-tight" style={{ fontFamily: 'Outfit' }}>Office</span>
        </div>
      </div>

      {/* Titulo da pagina atual (mobile only — substitui os links) */}
      <div className="topbar-current-page" style={{
        display: 'none', /* CSS media query liga em <768px */
        flex: 1, padding: '0 14px', fontSize: 14, fontWeight: 600,
        color: 'var(--ao-text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {activeLabel}
      </div>

      {/* Drawer mobile — menu lateral estilo iOS */}
      {mobileMenuOpen && (
        <>
          <div
            className="mobile-drawer-backdrop"
            onClick={() => setMobileMenuOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 150,
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            }}
          />
          <div
            className="mobile-drawer"
            style={{
              position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 151,
              width: 'min(320px, 88vw)', background: 'var(--ao-card)',
              borderRight: '1px solid var(--ao-border)',
              display: 'flex', flexDirection: 'column',
              boxShadow: '8px 0 32px rgba(0,0,0,0.5)',
              /* Safe area iOS: empurra conteudo abaixo do notch/dynamic island */
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            {/* Header drawer */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '14px 18px', borderBottom: '1px solid var(--ao-border)',
              flexShrink: 0,
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: 'linear-gradient(135deg, #6366F1 0%, #A67B52 100%)',
                boxShadow: '0 4px 14px rgba(196,149,106,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span style={{ color: '#fff', fontSize: 16, fontWeight: 900 }}>A</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>
                  <span style={{ color: 'var(--ao-text)' }}>Átrio </span>
                  <span style={{ color: '#6366F1' }}>Office</span>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)', marginTop: 2 }}>
                  {onlineCount}/{agents?.length || 0} agentes · {connected ? 'ao vivo' : 'offline'}
                </div>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                style={{
                  background: 'var(--ao-bg)', border: '1px solid var(--ao-border)',
                  cursor: 'pointer', color: 'var(--ao-text-dim)',
                  width: 32, height: 32, borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 0, flexShrink: 0,
                }}
                aria-label="Fechar menu"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {/* Conteudo scrollavel */}
            <div className="mobile-drawer-content" style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
              {/* Principal */}
              <div style={{ padding: '12px 18px 6px', fontSize: 10, fontWeight: 700, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                Principal
              </div>
              {INTERNAL.filter(l => l.group === 'principal').map(link => (
                <DrawerItem
                  key={link.id}
                  link={link}
                  active={currentPage === link.id}
                  onClick={() => { onNavigate?.(link.id); setMobileMenuOpen(false) }}
                />
              ))}

              {/* Operação */}
              <div style={{ padding: '14px 18px 6px', fontSize: 10, fontWeight: 700, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                Operação
              </div>
              {INTERNAL.filter(l => l.group === 'operacao').map(link => (
                <DrawerItem
                  key={link.id}
                  link={link}
                  active={currentPage === link.id}
                  onClick={() => { onNavigate?.(link.id); setMobileMenuOpen(false) }}
                />
              ))}

              {/* Gestão */}
              <div style={{ padding: '14px 18px 6px', fontSize: 10, fontWeight: 700, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                Gestão
              </div>
              {INTERNAL.filter(l => l.group === 'gestao').map(link => (
                <DrawerItem
                  key={link.id}
                  link={link}
                  active={currentPage === link.id}
                  onClick={() => { onNavigate?.(link.id); setMobileMenuOpen(false) }}
                />
              ))}

              {/* Sistemas externos */}
              <div style={{ padding: '14px 18px 6px', fontSize: 10, fontWeight: 700, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
                Sistemas
              </div>
              {SISTEMAS.map(s => (
                <button
                  key={s.label}
                  className="mobile-drawer-item"
                  onClick={() => { window.open(s.url, '_blank', 'noopener'); setMobileMenuOpen(false) }}
                  style={{
                    width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '12px 18px', border: 'none', background: 'transparent',
                    color: 'var(--ao-text-secondary)', fontSize: 14, fontWeight: 500,
                    display: 'flex', alignItems: 'center', gap: 14,
                    minHeight: 48,
                  }}
                >
                  <div style={{
                    width: 30, height: 30, borderRadius: 8,
                    background: 'var(--ao-bg)', border: '1px solid var(--ao-border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--ao-text-dim)', flexShrink: 0,
                  }}>
                    <ExternalLink size={14} />
                  </div>
                  <span style={{ flex: 1 }}>{s.label}</span>
                </button>
              ))}
            </div>

            {/* Footer drawer */}
            <div style={{
              padding: '10px 18px', borderTop: '1px solid var(--ao-border)',
              fontSize: 11, color: 'var(--ao-text-dim)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexShrink: 0,
              background: 'var(--ao-bg)',
            }}>
              <span>Átrio Contabilidade</span>
              <span style={{ fontFamily: 'Space Grotesk', fontVariantNumeric: 'tabular-nums' }}>
                {time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        </>
      )}

      {/* Links (desktop) */}
      <div className="topbar-links flex items-center h-full flex-1">
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
                  background: 'linear-gradient(90deg, #6366F1, #6366F180)',
                  boxShadow: '0 0 8px rgba(99, 102, 241, 0.3)',
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
            <div className="sistemas-dropdown absolute top-full left-2 mt-1 min-w-[200px] rounded-lg overflow-hidden z-[9999]">
              {SISTEMAS.map(s => (
                <button key={s.label}
                  onClick={() => { window.open(s.url, '_blank', 'noopener'); setSistOpen(false) }}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-left text-[12.5px] transition-colors"
                >
                  <span>{s.label}</span>
                  <svg className="w-3 h-3 opacity-60" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
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

        <KillSwitchBadge />

        <PushToggle />

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

/**
 * Item do drawer mobile — com icone, label e indicador de ativo.
 * Tap target minimo de 48px (Material Design) + feedback visual no active.
 */
function DrawerItem({ link, active, onClick }) {
  const Icon = link.Icon
  return (
    <button
      className="mobile-drawer-item"
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: '12px 18px', border: 'none',
        background: active ? 'var(--ao-surface)' : 'transparent',
        color: active ? 'var(--ao-text-primary)' : 'var(--ao-text-secondary)',
        fontSize: 14, fontWeight: active ? 600 : 500,
        display: 'flex', alignItems: 'center', gap: 14,
        minHeight: 48,
        position: 'relative',
      }}
    >
      {active && (
        <span style={{
          position: 'absolute', left: 0, top: 8, bottom: 8, width: 3,
          background: '#6366F1', borderRadius: '0 2px 2px 0',
        }} />
      )}
      <div style={{
        width: 30, height: 30, borderRadius: 8,
        background: active ? 'rgba(99, 102, 241, 0.12)' : 'var(--ao-bg)',
        border: active ? '1px solid rgba(99, 102, 241, 0.35)' : '1px solid var(--ao-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: active ? '#6366F1' : 'var(--ao-text-dim)', flexShrink: 0,
        transition: 'background 0.15s, color 0.15s',
      }}>
        {Icon ? <Icon size={14} strokeWidth={active ? 2.4 : 2} /> : null}
      </div>
      <span style={{ flex: 1 }}>{link.label}</span>
    </button>
  )
}

function KillSwitchBadge() {
  const [data, setData] = useState(null)
  useEffect(() => {
    const load = () => fetch('/api/security/agent-outbound-status').then(r => r.json()).then(setData).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [])
  if (!data?.kill_switch_active) return null
  return (
    <a
      href="#"
      onClick={e => { e.preventDefault(); window.alert(`Kill-switch ativo — agentes IA não enviam para clientes.\n\nÚltimas 24h: ${data.blocks_24h} tentativa(s) bloqueada(s) e redirecionada(s) pro grupo interno.\n\nPara reativar: env AGENT_CLIENT_OUTBOUND=on + restart.`) }}
      title={`Kill-switch ativo — ${data.blocks_24h} bloqueio(s) em 24h`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        height: 32, padding: '0 9px', borderRadius: 8,
        background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
        color: '#EF4444', fontSize: 11, fontWeight: 700,
        textDecoration: 'none', cursor: 'pointer',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      AGENTES OFF
      {data.blocks_24h > 0 && <span style={{ marginLeft: 2, opacity: 0.8 }}>· {data.blocks_24h}</span>}
    </a>
  )
}

function PushToggle() {
  const { supported, permission, subscribed, loading, enable, disable, error } = usePushNotifications('caio')
  if (!supported) return null
  const active = subscribed && permission === 'granted'
  const onClick = () => { if (active) disable(); else enable() }
  return (
    <button
      onClick={onClick}
      disabled={loading}
      title={active ? 'Desativar notificações push' : 'Ativar notificações push'}
      className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 cursor-pointer"
      style={{
        background: 'var(--ao-input-bg)',
        border: `1px solid ${active ? 'rgba(186,117,23,0.5)' : 'var(--ao-border)'}`,
        color: active ? '#6366F1' : 'var(--ao-text-muted)',
        opacity: loading ? 0.6 : 1,
      }}
    >
      {active ? <Bell size={14} /> : <BellOff size={14} />}
    </button>
  )
}
