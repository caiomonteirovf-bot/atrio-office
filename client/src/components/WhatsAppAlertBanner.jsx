import { useEffect, useState, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { AlertTriangle, X } from 'lucide-react'

/**
 * Banner FIXO no topo da tela quando WhatsApp está desconectado.
 * Diretiva CEO 2026-05-10: sem WhatsApp = perdendo conversas.
 * Tem que ser ÓBVIO. Pulse vermelho, click direto pro QR.
 *
 * Polla /api/whatsapp/status a cada 10s + reage a eventos WS.
 */
export default function WhatsAppAlertBanner() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [qrData, setQrData] = useState(null)
  const [dismissedAt, setDismissedAt] = useState(0)
  const [disconnectedSince, setDisconnectedSince] = useState(null)
  const [, setTick] = useState(0)
  const { lastMessage } = useWebSocket()
  const pollRef = useRef(null)

  const fetchStatus = async () => {
    try {
      const r = await fetch('/api/whatsapp/status')
      const j = await r.json()
      setStatus(j)
      if (!j.connected && !disconnectedSince) {
        setDisconnectedSince(Date.now())
      } else if (j.connected) {
        setDisconnectedSince(null)
        setShowQR(false)
        setQrData(null)
      }
    } catch {}
  }

  useEffect(() => {
    fetchStatus()
    pollRef.current = setInterval(fetchStatus, 10_000)
    const tickI = setInterval(() => setTick(t => t + 1), 5_000)
    return () => { clearInterval(pollRef.current); clearInterval(tickI) }
  }, [])

  // WS: reagir imediatamente a eventos de conexão
  useEffect(() => {
    if (!lastMessage) return
    const t = lastMessage.type
    if (t === 'whatsapp_disconnected' || t === 'whatsapp_ready' || t === 'whatsapp_qr') {
      fetchStatus()
      if (t === 'whatsapp_qr') {
        // QR foi gerado — busca pra exibir
        fetch('/api/whatsapp/qr').then(r => r.json()).then(d => {
          if (d.hasQR) setQrData(d.qr)
        }).catch(() => {})
      }
    }
  }, [lastMessage])

  const handleConnect = async () => {
    setLoading(true)
    try {
      // Tenta gerar QR
      const r = await fetch('/api/whatsapp/qr')
      const d = await r.json()
      if (d.hasQR) {
        setQrData(d.qr)
        setShowQR(true)
      } else {
        // Sem QR ainda — chama reconnect
        await fetch('/api/whatsapp/reconnect', { method: 'POST' }).catch(() => {})
        setShowQR(true)
      }
    } catch {}
    setLoading(false)
  }

  if (!status) return null
  if (status.connected) return null

  // Tempo desde desconexão
  const ageSec = disconnectedSince ? Math.floor((Date.now() - disconnectedSince) / 1000) : 0
  const ageLabel = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${Math.floor(ageSec / 60)}min` : `${Math.floor(ageSec / 3600)}h${Math.floor((ageSec % 3600) / 60)}min`

  const dismissedRecently = dismissedAt && (Date.now() - dismissedAt) < 30_000

  return (
    <>
      {/* Banner principal */}
      <div
        role="alert"
        className="wa-alert-pulse"
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: 'linear-gradient(90deg, #dc2626 0%, #b91c1c 50%, #dc2626 100%)',
          backgroundSize: '200% 100%',
          color: '#fff',
          padding: '10px 16px',
          display: dismissedRecently ? 'none' : 'flex',
          alignItems: 'center', gap: 12,
          fontSize: 13, fontWeight: 600,
          boxShadow: '0 2px 12px rgba(220, 38, 38, 0.45)',
          borderBottom: '1px solid rgba(0,0,0,0.25)',
        }}
      >
        <AlertTriangle size={18} style={{ flexShrink: 0, animation: 'wa-shake 1.2s ease-in-out infinite' }} />
        <div style={{ flex: 1, lineHeight: 1.4, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 13.5 }}>
            WhatsApp DESCONECTADO
            {disconnectedSince && <span style={{ fontWeight: 500, opacity: 0.9 }}> · há {ageLabel}</span>}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 500, opacity: 0.95 }}>
            Mensagens não estão sendo recebidas nem enviadas. Reconecte para evitar perda de conversas.
          </div>
        </div>
        <button
          onClick={handleConnect}
          disabled={loading}
          style={{
            padding: '6px 14px', fontSize: 12, fontWeight: 700,
            background: '#fff', color: '#b91c1c', border: 'none', borderRadius: 6,
            cursor: loading ? 'wait' : 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {loading ? 'Aguardando QR...' : status.hasQR ? 'Escanear QR' : 'Conectar agora'}
        </button>
        <button
          onClick={() => setDismissedAt(Date.now())}
          title="Esconder por 30s"
          style={{
            background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)',
            cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center',
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Spacer pra empurrar o conteúdo */}
      {!dismissedRecently && <div style={{ height: 56 }} />}

      {/* Modal QR Code */}
      {showQR && (
        <div
          onClick={() => setShowQR(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.7)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--ao-card)', padding: 20, borderRadius: 12,
              maxWidth: 360, width: '100%', textAlign: 'center',
              border: '1px solid var(--ao-border)',
            }}
          >
            <h3 style={{ margin: '0 0 12px', color: 'var(--ao-text-primary)' }}>Conectar WhatsApp</h3>
            {qrData ? (
              <>
                <div style={{ background: '#fff', padding: 12, borderRadius: 8, display: 'inline-block' }}>
                  <img src={qrData} alt="QR Code" style={{ width: 240, height: 240 }} />
                </div>
                <p style={{ marginTop: 12, fontSize: 12, color: 'var(--ao-text-dim)', lineHeight: 1.5 }}>
                  Abra o WhatsApp no celular →<br />
                  <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong>
                </p>
              </>
            ) : (
              <p style={{ color: 'var(--ao-text-dim)' }}>Gerando QR Code...</p>
            )}
            <button
              onClick={() => setShowQR(false)}
              style={{
                marginTop: 12, padding: '8px 16px', borderRadius: 6,
                border: '1px solid var(--ao-border)', background: 'transparent',
                color: 'var(--ao-text-secondary)', cursor: 'pointer',
              }}
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes wa-pulse-bg {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        @keyframes wa-shake {
          0%, 100% { transform: translateX(0) rotate(0deg); }
          25% { transform: translateX(-2px) rotate(-3deg); }
          75% { transform: translateX(2px) rotate(3deg); }
        }
        .wa-alert-pulse {
          animation: wa-pulse-bg 2.5s ease-in-out infinite;
        }
      `}</style>
    </>
  )
}
