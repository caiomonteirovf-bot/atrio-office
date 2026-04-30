import { useEffect, useState, useRef } from 'react'
import { AlertTriangle, AlertCircle, Clock, ChevronDown, X } from 'lucide-react'

/**
 * Banner global de itens vencendo. Aparece no topo da app SE houver:
 *   - vencido (vermelho pulsando)
 *   - critico (≤7d, laranja)
 *   - atencao (≤30d, amarelo claro - so mostra se nao houver vencido/critico)
 *
 * Refresh: a cada 5 min + on-demand via window.dispatchEvent('expiring:refresh').
 * Clicavel pra abrir dropdown com lista detalhada.
 * Pode ser dispensado por sessao (sessionStorage), mas reaparece se severity piorar.
 */
export default function ExpiringBanner() {
  const [data, setData] = useState({ items: [], counts: { vencido: 0, critico: 0, atencao: 0 } })
  const [open, setOpen] = useState(false)
  const [dismissedKey, setDismissedKey] = useState(() => sessionStorage.getItem('expiring_dismissed') || '')
  const ref = useRef(null)

  const load = async () => {
    try {
      const r = await fetch('/api/expiring-data')
      const j = await r.json()
      setData(j)
    } catch { /* silent */ }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 5 * 60 * 1000) // 5 min
    const handler = () => load()
    window.addEventListener('expiring:refresh', handler)
    return () => { clearInterval(id); window.removeEventListener('expiring:refresh', handler) }
  }, [])

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const { vencido, critico, atencao } = data.counts || {}
  const total = (vencido || 0) + (critico || 0) + (atencao || 0)
  if (total === 0) return null

  // Severidade dominante
  const sev = vencido > 0 ? 'vencido' : critico > 0 ? 'critico' : 'atencao'

  // Chave pra dismiss baseada em severity + counts (se piorar, reaparece)
  const currentKey = `${sev}:${vencido}:${critico}:${atencao}`
  if (dismissedKey === currentKey && sev !== 'vencido') return null

  const styles = {
    vencido: { bg: '#7F1D1D', border: '#DC2626', text: '#FEE2E2', accent: '#FCA5A5', icon: AlertCircle, pulse: true },
    critico: { bg: '#7C2D12', border: '#EA580C', text: '#FFEDD5', accent: '#FDBA74', icon: AlertTriangle, pulse: false },
    atencao: { bg: '#78350F', border: '#D97706', text: '#FEF3C7', accent: '#FCD34D', icon: Clock, pulse: false },
  }[sev]
  const Icon = styles.icon

  let summary
  if (vencido > 0 && critico > 0) summary = `${vencido} vencido${vencido > 1 ? 's' : ''}, ${critico} critico${critico > 1 ? 's' : ''}`
  else if (vencido > 0) summary = `${vencido} item${vencido > 1 ? 's' : ''} vencido${vencido > 1 ? 's' : ''}`
  else if (critico > 0) summary = `${critico} vence${critico > 1 ? 'm' : ''} em ate 7 dias`
  else summary = `${atencao} vence${atencao > 1 ? 'm' : ''} em ate 30 dias`

  const dismiss = (e) => {
    e.stopPropagation()
    sessionStorage.setItem('expiring_dismissed', currentKey)
    setDismissedKey(currentKey)
  }

  return (
    <div ref={ref} style={{
      position: 'sticky', top: 0, zIndex: 50,
      background: styles.bg,
      borderBottom: `2px solid ${styles.border}`,
      color: styles.text,
      animation: styles.pulse ? 'expiring-pulse 2s ease-in-out infinite' : undefined,
    }}>
      <style>{`
        @keyframes expiring-pulse {
          0%, 100% { box-shadow: inset 0 0 0 0 rgba(220,38,38,0); }
          50%      { box-shadow: inset 0 -3px 0 0 rgba(220,38,38,0.6); }
        }
      `}</style>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 16px', cursor: 'pointer', background: 'transparent',
          border: 'none', color: styles.text, fontFamily: 'inherit',
        }}
      >
        <Icon size={18} style={{ color: styles.accent, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {summary} —
        </span>
        <span style={{ fontSize: 13, opacity: 0.85 }}>
          clique pra ver detalhes
        </span>
        <ChevronDown size={14} style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        {sev !== 'vencido' && (
          <span
            role="button"
            tabIndex={0}
            onClick={dismiss}
            onKeyDown={(e) => e.key === 'Enter' && dismiss(e)}
            title="Dispensar nesta sessao"
            style={{
              padding: '4px 6px', borderRadius: 4,
              background: 'rgba(255,255,255,0.08)',
              display: 'inline-flex', alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <X size={12} />
          </span>
        )}
      </button>

      {open && (
        <div style={{
          maxHeight: 380, overflowY: 'auto',
          background: 'rgba(0,0,0,0.25)',
          borderTop: `1px solid ${styles.border}`,
        }}>
          {data.items.map(it => {
            const sevColor = it.severity === 'vencido' ? '#DC2626'
              : it.severity === 'critico' ? '#EA580C' : '#D97706'
            return (
              <a
                key={it.id}
                href={it.url}
                target={it.url?.startsWith('http') ? '_blank' : undefined}
                rel="noreferrer"
                style={{
                  display: 'flex', gap: 10, padding: '10px 16px',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  textDecoration: 'none', color: 'inherit',
                  alignItems: 'flex-start',
                }}
              >
                <span style={{
                  display: 'inline-block',
                  fontSize: 9, fontWeight: 700,
                  textTransform: 'uppercase',
                  padding: '2px 6px', borderRadius: 3,
                  background: sevColor, color: 'white',
                  flexShrink: 0, marginTop: 2,
                }}>
                  {it.severity}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: styles.accent }}>
                    {it.title}
                  </div>
                  <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 2 }}>
                    {it.subtitle}
                  </div>
                </div>
                <span style={{ fontSize: 10, opacity: 0.6, textTransform: 'uppercase', flexShrink: 0 }}>
                  {it.system}
                </span>
              </a>
            )
          })}
          {data.items.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>
              Nada pra mostrar
            </div>
          )}
        </div>
      )}
    </div>
  )
}
