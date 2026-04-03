import { useState, useEffect } from 'react'

export default function WhatsAppStatus() {
  const [status, setStatus] = useState(null)
  const [qr, setQr] = useState(null)
  const [showQR, setShowQR] = useState(false)

  useEffect(() => {
    checkStatus()
    const interval = setInterval(checkStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  async function checkStatus() {
    try {
      const res = await fetch('/api/whatsapp/status')
      const data = await res.json()
      setStatus(data)

      if (data.hasQR && !data.connected) {
        const qrRes = await fetch('/api/whatsapp/qr')
        const qrData = await qrRes.json()
        if (qrData.hasQR) setQr(qrData.qr)
      } else {
        setQr(null)
      }
    } catch {
      setStatus(null)
    }
  }

  if (!status) return null

  return (
    <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 flex items-center justify-center text-[16px]">
            W
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-slate-200">WhatsApp — Luna</h3>
            <p className="text-[11px] text-slate-500">
              {status.connected
                ? `Conectado: ${status.phone}`
                : status.hasQR
                  ? 'Aguardando QR Code...'
                  : 'Inicializando...'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${
            status.connected
              ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
              : 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.4)]'
          }`} />
          {status.hasQR && !status.connected && (
            <button
              onClick={() => setShowQR(!showQR)}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {showQR ? 'Esconder QR' : 'Mostrar QR'}
            </button>
          )}
        </div>
      </div>

      {/* QR Code */}
      {showQR && qr && (
        <div className="mt-4 flex flex-col items-center">
          <p className="text-[11px] text-slate-400 mb-3">Escaneie com seu WhatsApp</p>
          <div className="bg-white rounded-xl p-3">
            <img src={qr} alt="QR Code WhatsApp" className="w-48 h-48" />
          </div>
        </div>
      )}
    </div>
  )
}
