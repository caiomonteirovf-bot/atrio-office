import { useState, useEffect } from 'react'

const SEVERITY_CONFIG = {
  normal: { color: 'text-amber-400', bg: 'bg-amber-500/10', icon: '🟡' },
  atencao: { color: 'text-orange-400', bg: 'bg-orange-500/10', icon: '🟠' },
  critico: { color: 'text-red-400', bg: 'bg-red-500/10', icon: '🔴' },
  urgente: { color: 'text-red-500', bg: 'bg-red-500/15', icon: '🚨' },
  grave: { color: 'text-red-600', bg: 'bg-red-600/15', icon: '🚨' },
}

function timeSince(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)}min`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`
  return `${Math.floor(s / 86400)}d`
}

export default function AttendanceQueue() {
  const [queue, setQueue] = useState([])
  const [wsStatus, setWsStatus] = useState(null)

  useEffect(() => {
    load()
    const interval = setInterval(load, 10000)
    return () => clearInterval(interval)
  }, [])

  async function load() {
    try {
      const [pending, status] = await Promise.all([
        fetch('/api/whatsapp/pending').then(r => r.json()),
        fetch('/api/whatsapp/status').then(r => r.json()),
      ])
      setQueue(pending)
      setWsStatus(status)
    } catch {}
  }

  if (!wsStatus?.connected) {
    return (
      <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          <span className="text-[13px] text-slate-400">WhatsApp desconectado</span>
        </div>
      </div>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">
            Atendimento WhatsApp
          </h2>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]" />
            <span className="text-[10px] text-slate-500">Luna ativa</span>
          </div>
        </div>
        {queue.length > 0 && (
          <span className="text-[11px] text-amber-400 font-medium">
            {queue.length} aguardando
          </span>
        )}
      </div>

      {queue.length === 0 ? (
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-6 text-center">
          <p className="text-slate-500 text-[12px]">Nenhum atendimento pendente</p>
          <p className="text-slate-600 text-[10px] mt-1">Quando clientes mandarem mensagem, aparecerão aqui</p>
        </div>
      ) : (
        <div className="space-y-2">
          {queue.map(item => {
            const sev = SEVERITY_CONFIG[item.severity] || SEVERITY_CONFIG.normal
            return (
              <div
                key={item.phone}
                className={`${sev.bg} border border-slate-700/30 rounded-xl p-4 transition-all`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <span className="text-[14px] mt-0.5">{sev.icon}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-[13px] font-semibold text-slate-200">{item.name}</h3>
                        <span className={`text-[10px] font-medium ${sev.color}`}>{item.severity}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">{item.phone}</p>
                      <p className="text-[11px] text-slate-500 mt-1 italic line-clamp-1">
                        "{item.lastMessage?.substring(0, 80)}"
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-[11px] text-slate-400 tabular-nums">
                      {timeSince(item.receivedAt)}
                    </span>
                    {item.humanReplied && (
                      <p className="text-[9px] text-amber-400 mt-0.5">Respondido, insistiu</p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
