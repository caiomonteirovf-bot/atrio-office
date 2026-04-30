import { useState, useCallback, useEffect } from 'react'
import { User } from 'lucide-react'
import ConversaList from './ConversaList'
import ChatPane from './ChatPane'
import RightPane from './RightPane'

/**
 * Rota /atendimento — ve e responde conversas WhatsApp.
 *
 * Layout:
 *  - Desktop largo (>= 1200px): 3 colunas — lista (300px) + chat (flex) + cliente (340px)
 *  - Desktop medio (768-1199px): 2 colunas — lista + chat (painel cliente via toggle no header)
 *  - Mobile (< 768px): 1 coluna por vez (lista OU chat OU cliente via bottom sheet)
 */
export default function ConversasPage({ lastWsMessage }) {
  const [selected, setSelected] = useState(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [clientPaneOpen, setClientPaneOpen] = useState(true) // toggle pra tela media
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 768
  )
  const [isWide, setIsWide] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1200
  )

  // Responsive: alterna layout conforme largura da tela
  useEffect(() => {
    const onResize = () => {
      setIsMobile(window.innerWidth < 768)
      setIsWide(window.innerWidth >= 1200)
    }
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const refreshList = useCallback(() => {
    setRefreshToken(t => t + 1)
  }, [])

  // Mobile: lista OU chat (com bottom sheet pro cliente)
  const [mobileClientOpen, setMobileClientOpen] = useState(false)
  if (isMobile) {
    return (
      <div style={{
        position: 'fixed', left: 0, right: 0, top: 52,
        /* bottom: apenas safe-area-inset-bottom do iPhone (home indicator) — sem bottom nav, StatusBar escondida */
        bottom: 'env(safe-area-inset-bottom)',
        display: 'flex', flexDirection: 'column',
        background: 'var(--ao-bg)',
      }}>
        {!selected ? (
          <ConversaList
            selectedId={null}
            onSelect={setSelected}
            lastWsMessage={lastWsMessage}
            refreshToken={refreshToken}
          />
        ) : (
          <>
            <ChatPane
              conversation={selected}
              onBack={() => setSelected(null)}
              lastWsMessage={lastWsMessage}
              onRefreshList={refreshList}
              extraHeaderButton={(
                <button
                  onClick={() => setMobileClientOpen(true)}
                  title="Ver detalhes do cliente"
                  style={{
                    padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6,
                    border: '1px solid var(--ao-border)',
                    background: 'var(--ao-bg)', color: 'var(--ao-text-secondary)',
                    cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <User size={11} />
                  Cliente
                </button>
              )}
            />
            {/* Bottom sheet — painel cliente (estilo iOS) */}
            {mobileClientOpen && (
              <div
                onClick={() => setMobileClientOpen(false)}
                className="mobile-drawer-backdrop"
                style={{
                  position: 'fixed', inset: 0, zIndex: 150,
                  background: 'rgba(0,0,0,0.55)',
                  backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
                  display: 'flex', alignItems: 'flex-end',
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="bottom-sheet-content"
                  style={{
                    width: '100%',
                    height: '88vh', maxHeight: 'calc(100vh - env(safe-area-inset-top) - 20px)',
                    background: 'var(--ao-bg)',
                    borderTopLeftRadius: 20, borderTopRightRadius: 20,
                    overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    boxShadow: '0 -8px 32px rgba(0,0,0,0.5)',
                    paddingBottom: 'env(safe-area-inset-bottom)',
                  }}
                >
                  {/* Handle bar — indicador visual "arrastavel" (tambem clica-fecha) */}
                  <div
                    onClick={() => setMobileClientOpen(false)}
                    style={{
                      padding: '8px 0 4px', display: 'flex', justifyContent: 'center',
                      cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    <div style={{
                      width: 38, height: 4, borderRadius: 2,
                      background: 'var(--ao-border)',
                    }} />
                  </div>
                  <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <RightPane
                      conversation={selected}
                      onClose={() => setMobileClientOpen(false)}
                      lastWsMessage={lastWsMessage}
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  // Desktop: 2 ou 3 colunas dependendo da largura
  const showClientPane = isWide && clientPaneOpen && !!selected
  return (
    <div style={{
      display: 'flex', height: '100%',
      paddingBottom: 28, /* reserva espaco pra StatusBar fixa (z-40) nao cobrir o input */
      background: 'var(--ao-bg)',
      boxSizing: 'border-box',
    }}>
      <div style={{ width: 300, flexShrink: 0, height: '100%' }}>
        <ConversaList
          selectedId={selected?.id}
          onSelect={setSelected}
          lastWsMessage={lastWsMessage}
          refreshToken={refreshToken}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ChatPane
          conversation={selected}
          onBack={null}
          lastWsMessage={lastWsMessage}
          onRefreshList={refreshList}
          extraHeaderButton={selected && !isWide ? (
            <button
              onClick={() => setClientPaneOpen(v => !v)}
              title="Ver/ocultar detalhes do cliente"
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6,
                border: '1px solid var(--ao-border)',
                background: clientPaneOpen ? 'var(--ao-surface)' : 'transparent',
                color: 'var(--ao-text-secondary)', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              <User size={11} />
              Cliente
            </button>
          ) : null}
        />
      </div>
      {showClientPane && (
        <div style={{
          width: 340, flexShrink: 0, height: '100%',
          borderLeft: '1px solid var(--ao-border)',
        }}>
          <RightPane
            conversation={selected}
            onClose={null}
            lastWsMessage={lastWsMessage}
          />
        </div>
      )}
      {/* Tela media (768-1199px): painel sobreposto quando toggle aberto */}
      {!isWide && !isMobile && selected && clientPaneOpen && (
        <div
          onClick={() => setClientPaneOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 90,
            background: 'rgba(0,0,0,0.4)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', right: 0, top: 0, bottom: 0,
              width: 340, background: 'var(--ao-bg)',
              borderLeft: '1px solid var(--ao-border)',
              animation: 'slideInRight 0.22s ease-out',
            }}
          >
            <RightPane
              conversation={selected}
              onClose={() => setClientPaneOpen(false)}
              lastWsMessage={lastWsMessage}
            />
          </div>
        </div>
      )}
    </div>
  )
}
