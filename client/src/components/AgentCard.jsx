import { useState, useEffect } from 'react'

// Estado visual baseado na atividade REAL (tasks)
const ACTIVITY_CONFIG = {
  working: {
    label: 'Executando',
    dotClass: 'bg-amber-400',
    dotGlow: 'rgba(251,191,36,0.6)',
    showVistaBar: true,
    opacity: '',
  },
  blocked: {
    label: 'Bloqueado',
    dotClass: 'bg-red-400',
    dotGlow: 'rgba(248,113,113,0.6)',
    showVistaBar: false,
    opacity: '',
  },
  pending: {
    label: 'Na fila',
    dotClass: 'bg-blue-400',
    dotGlow: 'rgba(96,165,250,0.4)',
    showVistaBar: false,
    opacity: '',
  },
  standby: {
    label: 'Stand-by',
    dotClass: 'bg-gray-400/20',
    dotGlow: 'none',
    showVistaBar: false,
    opacity: 'opacity-60',
  },
  offline: {
    label: 'Offline',
    dotClass: 'bg-gray-400/10',
    dotGlow: 'none',
    showVistaBar: false,
    opacity: 'opacity-40',
  },
}

const LABEL_COLORS = {
  working: '#fbbf24',
  blocked: '#f87171',
  pending: '#60a5fa',
  standby: 'var(--ao-text-dim)',
  offline: 'var(--ao-text-xs)',
}

export default function AgentCard({ agent, isSelected, onClick }) {
  const color = agent.config?.color || '#6366f1'
  const letter = agent.config?.avatar_letter || agent.name[0]
  const [pulse, setPulse] = useState(false)

  // Resolve estado: offline > working > blocked > pending > standby
  const activityKey = agent.status !== 'online'
    ? 'offline'
    : (agent.activity || 'standby')
  const act = ACTIVITY_CONFIG[activityKey] || ACTIVITY_CONFIG.standby

  // Pulse so para working
  useEffect(() => {
    if (activityKey !== 'working') return
    const interval = setInterval(() => {
      setPulse(true)
      setTimeout(() => setPulse(false), 1000)
    }, 3000 + Math.random() * 2000)
    return () => clearInterval(interval)
  }, [activityKey])

  // Trunca titulo da task para exibicao
  const taskLabel = agent.taskTitle
    ? agent.taskTitle.replace(/^\[.*?\]\s*/, '').substring(0, 40)
    : null

  return (
    <button
      onClick={onClick}
      className={`group relative text-left rounded-xl p-3.5 transition-all duration-300 cursor-pointer overflow-hidden
        ${act.opacity}`}
      style={{
        background: isSelected
          ? `linear-gradient(135deg, ${color}12 0%, ${color}06 100%)`
          : `linear-gradient(135deg, var(--ao-glass) 0%, var(--ao-glass-half) 100%)`,
        border: isSelected
          ? `1px solid ${color}30`
          : activityKey === 'working'
            ? `1px solid ${color}15`
            : activityKey === 'blocked'
              ? '1px solid rgba(248, 113, 113, 0.15)'
              : `1px solid var(--ao-border)`,
        boxShadow: isSelected
          ? `0 4px 24px ${color}10, inset 0 0 40px ${color}05`
          : activityKey === 'working'
            ? `0 0 20px ${color}08`
            : 'none',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.borderColor = 'var(--ao-border-hover)'
          e.currentTarget.style.background = `linear-gradient(135deg, var(--ao-glass-hover) 0%, var(--ao-glass-hover-half) 100%)`
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.borderColor = activityKey === 'working' ? `${color}15` : activityKey === 'blocked' ? 'rgba(248, 113, 113, 0.15)' : 'var(--ao-border)'
          e.currentTarget.style.background = `linear-gradient(135deg, var(--ao-glass) 0%, var(--ao-glass-half) 100%)`
        }
      }}
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="relative">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-[14px] transition-all duration-700 ${pulse ? 'scale-110' : 'scale-100'}`}
            style={{
              background: `linear-gradient(135deg, ${color}${activityKey === 'standby' ? '0c' : '20'} 0%, ${color}${activityKey === 'standby' ? '05' : '0a'} 100%)`,
              color: activityKey === 'standby' ? `${color}80` : color,
              border: `1px solid ${color}${activityKey === 'standby' ? '08' : '18'}`,
              boxShadow: activityKey === 'working' ? `0 0 20px ${color}15` : 'none',
            }}
          >
            {letter}
          </div>
          {/* Status dot */}
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${act.dotClass}`}
            style={{ boxShadow: act.dotGlow !== 'none' ? `0 0 8px ${act.dotGlow}` : 'none', borderWidth: 2, borderStyle: 'solid', borderColor: 'var(--ao-surface)' }}
          />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-bold truncate" style={{ fontFamily: 'Outfit', color: 'var(--ao-text-primary)' }}>{agent.name}</h3>
            <span className="text-[10px] font-semibold" style={{ color: LABEL_COLORS[activityKey] || 'var(--ao-text-dim)' }}>{act.label}</span>
          </div>
          <p className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--ao-text-dim)' }}>{agent.role}</p>

          {/* Department + Task */}
          <div className="flex items-center gap-2 mt-2">
            <span
              className="text-[9px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-wider"
              style={{ background: `${color}10`, color: `${color}99`, border: `1px solid ${color}10` }}
            >
              {agent.department}
            </span>
            {taskLabel && (
              <span className="text-[10px] truncate max-w-[140px]"
                style={{ color: activityKey === 'blocked' ? 'rgba(248,113,113,0.6)' : 'var(--ao-text-xs)' }}>
                {taskLabel}
              </span>
            )}
          </div>
        </div>

        {/* Arrow */}
        <div className={`transition-all ${isSelected ? 'opacity-80' : 'opacity-20 group-hover:opacity-50'}`}
          style={{ color: isSelected ? color : 'var(--ao-text)' }}>
          {activityKey === 'blocked' ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="#f87171" strokeWidth="1.5"/>
              <path d="M6 6l4 4M10 6l-4 4" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </div>
      </div>

      {/* Personality snippet — standby only */}
      {activityKey === 'standby' && agent.personality && (
        <p className="text-[10px] mt-2.5 line-clamp-1 italic pl-[52px]" style={{ color: 'var(--ao-text-xs)' }}>
          &ldquo;{agent.personality.substring(0, 70)}&hellip;&rdquo;
        </p>
      )}

      {/* Vista loading bar */}
      {act.showVistaBar && (
        <div
          className="absolute bottom-0 left-3 right-3 vista-bar-agent rounded-b-xl"
          style={{ '--agent-color': color }}
        />
      )}

      {/* Blocked bar */}
      {activityKey === 'blocked' && (
        <div className="absolute bottom-0 left-3 right-3 h-[2px] rounded-b-xl bg-red-500/20" />
      )}
    </button>
  )
}
