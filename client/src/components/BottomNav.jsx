import { Home, MessageSquare, Grid3X3, Calendar, Menu } from 'lucide-react'

/**
 * Bottom navigation bar — visivel apenas em mobile (< 768px via CSS).
 * Mostra 4 links principais + botao "Mais" que abre o drawer lateral.
 *
 * Padrao iOS/Android: thumb-friendly, sempre visivel, sem precisar abrir menu.
 * Respeita safe-area-inset-bottom do iPhone (home indicator).
 */
const ITEMS = [
  { id: 'home', label: 'Escritório', Icon: Home },
  { id: 'atendimento', label: 'Atendimento', Icon: MessageSquare },
  { id: 'ecossistema', label: 'Ecossistema', Icon: Grid3X3 },
  { id: 'calendar', label: 'Calendário', Icon: Calendar },
]

export default function BottomNav({ currentPage, onNavigate, onOpenMenu }) {
  return (
    <nav
      className="bottom-nav"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 90,
        display: 'none', /* CSS mobile media query liga como flex */
        background: 'var(--ao-card)',
        borderTop: '1px solid var(--ao-border)',
        /* Safe area iOS: empurra acima do home indicator */
        paddingBottom: 'env(safe-area-inset-bottom)',
        boxShadow: '0 -4px 16px rgba(0,0,0,0.25)',
      }}
    >
      {ITEMS.map(item => {
        const active = currentPage === item.id
        const Icon = item.Icon
        return (
          <button
            key={item.id}
            onClick={() => onNavigate?.(item.id)}
            className="bottom-nav-item"
            style={{
              flex: 1,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, padding: '8px 4px', minHeight: 56,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: active ? '#6366F1' : 'var(--ao-text-dim)',
              fontSize: 10, fontWeight: active ? 700 : 500,
              transition: 'color 0.12s',
              position: 'relative',
            }}
          >
            {active && (
              <span style={{
                position: 'absolute', top: 0, left: '25%', right: '25%', height: 2,
                background: '#6366F1', borderRadius: '0 0 2px 2px',
              }} />
            )}
            <Icon size={19} strokeWidth={active ? 2.4 : 2} />
            <span style={{ fontSize: 10, lineHeight: 1 }}>{item.label}</span>
          </button>
        )
      })}
      {/* Botao Mais — abre o drawer com o resto dos modulos */}
      <button
        onClick={onOpenMenu}
        className="bottom-nav-item"
        style={{
          flex: 1,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 3, padding: '8px 4px', minHeight: 56,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ao-text-dim)',
          fontSize: 10, fontWeight: 500,
        }}
        aria-label="Mais módulos"
      >
        <Menu size={19} strokeWidth={2} />
        <span style={{ fontSize: 10, lineHeight: 1 }}>Mais</span>
      </button>
    </nav>
  )
}
