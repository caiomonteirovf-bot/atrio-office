import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'

function AnimatedNumber({ value, duration = 800 }) {
  const [display, setDisplay] = useState(0)
  const ref = useRef(null)

  useEffect(() => {
    if (typeof value !== 'number') return
    const start = display
    const diff = value - start
    if (diff === 0) return
    const startTime = performance.now()

    function tick(now) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(start + diff * eased))
      if (progress < 1) ref.current = requestAnimationFrame(tick)
    }

    ref.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(ref.current)
  }, [value])

  return <span>{typeof value === 'number' ? display : '\u2014'}</span>
}

function NpsIndicator({ nps, negativos }) {
  if (nps === null && !negativos) return <span className="text-3xl font-extrabold" style={{ fontFamily: 'Outfit', color: 'var(--ao-text-xs)' }}>{'\u2014'}</span>

  const color = nps >= 8 ? '#22c55e' : nps >= 6 ? '#f59e0b' : nps !== null ? '#ef4444' : '#64748b'
  const label = nps >= 8 ? 'Bom' : nps >= 6 ? 'Atencao' : nps !== null ? 'Critico' : ''

  return (
    <div className="flex items-baseline gap-2">
      {nps !== null ? (
        <span className="text-3xl font-extrabold tabular-nums" style={{ fontFamily: 'Outfit', color }}>{nps.toFixed(1)}</span>
      ) : (
        <span className="text-3xl font-extrabold" style={{ fontFamily: 'Outfit', color: 'var(--ao-text-xs)' }}>{'\u2014'}</span>
      )}
      {label && <span className="text-[11px] font-semibold" style={{ color }}>{label}</span>}
      {negativos > 0 && (
        <span className="text-[11px] text-red-400 font-semibold ml-1">({negativos} negativo{negativos > 1 ? 's' : ''})</span>
      )}
    </div>
  )
}

function StatIcon({ type }) {
  const iconProps = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }

  if (type === 'pendentes') return (
    <svg {...iconProps} stroke="currentColor">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
  if (type === 'alertas') return (
    <svg {...iconProps} stroke="currentColor">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
  if (type === 'conversas') return (
    <svg {...iconProps} stroke="currentColor">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  )
  if (type === 'sentimento') return (
    <svg {...iconProps} stroke="currentColor">
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </svg>
  )
  return null
}

export default function StatsBar() {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    api.getStats().then(setStats).catch(() => {})
    const interval = setInterval(() => {
      api.getStats().then(setStats).catch(() => {})
    }, 15000)
    return () => clearInterval(interval)
  }, [])

  const pendentes = stats?.pendentes ?? null
  const alertas = stats?.alertas ?? null
  const conversas = stats?.conversas_hoje ?? null
  const sentimento = stats?.sentimento

  const loading = !stats

  const cards = [
    {
      id: 'pendentes',
      label: 'Pendentes',
      sublabel: 'Aguardando resposta',
      icon: 'pendentes',
      gradient: 'stat-gradient-amber',
      value: pendentes,
      color: pendentes > 0 ? '#f59e0b' : 'var(--ao-text-dim)',
      iconColor: '#f59e0b',
      alert: pendentes > 3,
      alertColor: '#f59e0b',
    },
    {
      id: 'alertas',
      label: 'Alertas',
      sublabel: alertas > 0 ? 'Precisa de acao' : 'Tudo operacional',
      icon: 'alertas',
      gradient: 'stat-gradient-red',
      value: alertas,
      color: alertas > 0 ? '#ef4444' : '#22c55e',
      iconColor: '#ef4444',
      alert: alertas > 0,
      alertColor: '#ef4444',
    },
    {
      id: 'conversas',
      label: 'Conversas hoje',
      sublabel: 'Contatos do dia',
      icon: 'conversas',
      gradient: 'stat-gradient-gold',
      value: conversas,
      color: 'var(--ao-text-primary)',
      iconColor: '#C4956A',
      alert: false,
    },
    {
      id: 'sentimento',
      label: 'Sentimento',
      sublabel: 'NPS medio (7 dias)',
      icon: 'sentimento',
      gradient: 'stat-gradient-emerald',
      iconColor: '#22c55e',
      isNps: true,
    },
  ]

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      {cards.map(card => (
        <div
          key={card.id}
          className={`relative glass-card rounded-xl px-4 py-3.5 overflow-hidden ${card.gradient} ${loading ? 'shimmer-bg' : ''}`}
        >
          {/* Icon + label */}
          <div className="flex items-center gap-2 mb-2.5">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{ background: `${card.iconColor}12`, color: card.iconColor }}>
              <StatIcon type={card.icon} />
            </div>
            <span className="text-[12px] font-medium" style={{ color: 'var(--ao-text-dim)' }}>{card.label}</span>
          </div>

          {/* Value */}
          {card.isNps ? (
            <NpsIndicator nps={sentimento?.nps_medio ?? null} negativos={sentimento?.negativos ?? 0} />
          ) : (
            <p className="text-3xl font-extrabold tabular-nums" style={{ fontFamily: 'Outfit', color: card.color }}>
              <AnimatedNumber value={card.value} />
            </p>
          )}

          {/* Sub label */}
          <p className="text-[10px] mt-1.5" style={{ color: 'var(--ao-text-xs)' }}>{card.sublabel}</p>

          {/* Loading bar */}
          {loading && <div className="absolute bottom-0 left-0 right-0 vista-bar" />}

          {/* Alert bar */}
          {card.alert && !loading && (
            <div className="absolute bottom-0 left-0 right-0 vista-bar-agent" style={{ '--agent-color': card.alertColor }} />
          )}
        </div>
      ))}
    </div>
  )
}
