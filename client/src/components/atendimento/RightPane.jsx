import { useState, useEffect } from 'react'
import { User, Sparkles } from 'lucide-react'
import ClientDetailPane from './ClientDetailPane'
import CopilotPane from './CopilotPane'
import { fetchClientContext } from './atendimento-api'

/**
 * Painel direito da conversa com tabs: [Cliente | Copilot].
 * Busca o client context uma vez e passa pros dois painéis pra não refetchar.
 */
export default function RightPane({ conversation: conv, onClose, lastWsMessage }) {
  const [tab, setTab] = useState('cliente')
  const [ctx, setCtx] = useState(null)

  useEffect(() => {
    if (!conv?.id) { setCtx(null); return }
    fetchClientContext(conv.id).then(setCtx).catch(() => {})
  }, [conv?.id])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ao-bg)' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--ao-border)',
        background: 'var(--ao-card)',
      }}>
        <TabButton
          active={tab === 'cliente'}
          onClick={() => setTab('cliente')}
          icon={<User size={13} />}
          label="Cliente"
          color="#10B981"
        />
        <TabButton
          active={tab === 'copilot'}
          onClick={() => setTab('copilot')}
          icon={<Sparkles size={13} />}
          label="Copilot"
          color="#6366F1"
        />
        {onClose && (
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto', padding: '0 12px',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--ao-text-dim)',
            }}
            aria-label="Fechar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      {/* Conteudo da tab */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'cliente' && (
          <ClientDetailPane
            conversation={conv}
            onClose={null}
            lastWsMessage={lastWsMessage}
          />
        )}
        {tab === 'copilot' && (
          <CopilotPane
            conversation={conv}
            client={ctx?.client || null}
          />
        )}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, icon, label, color }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '10px 14px', fontSize: 12, fontWeight: active ? 700 : 500,
        border: 'none', background: 'transparent', cursor: 'pointer',
        color: active ? color : 'var(--ao-text-dim)',
        borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        transition: 'color 0.12s, border-color 0.12s',
      }}
    >
      {icon}
      {label}
    </button>
  )
}
