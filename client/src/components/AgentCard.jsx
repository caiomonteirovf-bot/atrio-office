import { useState, useEffect } from 'react'

const STATUS_MAP = {
  online: { label: 'Online', dotClass: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' },
  busy: { label: 'Ocupado', dotClass: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.4)]' },
  offline: { label: 'Offline', dotClass: 'bg-slate-600' },
}

export default function AgentCard({ agent, isSelected, onClick }) {
  const color = agent.config?.color || '#6366f1'
  const letter = agent.config?.avatar_letter || agent.name[0]
  const status = STATUS_MAP[agent.status] || STATUS_MAP.offline
  const [pulse, setPulse] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => {
      if (agent.status === 'online') {
        setPulse(true)
        setTimeout(() => setPulse(false), 1000)
      }
    }, 6000 + Math.random() * 4000)
    return () => clearInterval(interval)
  }, [agent.status])

  return (
    <button
      onClick={onClick}
      className={`group relative text-left rounded-xl p-4 transition-all duration-300 border cursor-pointer
        ${isSelected
          ? 'bg-slate-800/80 border-indigo-500/30 shadow-lg shadow-indigo-500/5'
          : 'bg-slate-800/40 border-slate-700/30 hover:bg-slate-800/60 hover:border-slate-600/50'
        }`}
    >
      <div className="flex items-start gap-3.5">
        {/* Avatar */}
        <div className="relative">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center font-bold text-[15px] transition-transform duration-700 ${pulse ? 'scale-110' : 'scale-100'}`}
            style={{
              backgroundColor: `${color}18`,
              color: color,
              boxShadow: isSelected ? `0 0 24px ${color}15` : 'none',
            }}
          >
            {letter}
          </div>
          <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#1e293b] ${status.dotClass}`} />
          {agent.status === 'online' && (
            <span
              className={`absolute -top-1 -right-1 w-2 h-2 rounded-full transition-opacity duration-1000 ${pulse ? 'opacity-100' : 'opacity-0'}`}
              style={{ backgroundColor: color }}
            />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-slate-100 truncate">{agent.name}</h3>
            <span className="text-[10px] text-slate-500">{status.label}</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5 truncate">{agent.role}</p>
          <div className="flex items-center gap-2 mt-2.5">
            <span
              className="text-[9px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
              style={{ backgroundColor: `${color}12`, color: `${color}cc` }}
            >
              {agent.department}
            </span>
          </div>
        </div>

        {/* Arrow */}
        <div className={`text-slate-600 group-hover:text-slate-400 transition-all ${isSelected ? 'text-indigo-400' : ''}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {agent.personality && (
        <p className="text-[10px] text-slate-600 mt-3 line-clamp-1 italic">
          "{agent.personality.substring(0, 80)}..."
        </p>
      )}

      {isSelected && (
        <div className="absolute inset-0 rounded-xl pointer-events-none"
          style={{ boxShadow: `inset 0 0 40px ${color}05` }} />
      )}
    </button>
  )
}
