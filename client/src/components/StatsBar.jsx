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

  return <span>{typeof value === 'number' ? display : '—'}</span>
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

  const cards = [
    { label: 'Tasks ativas', value: stats ? (stats.tasks?.pending || 0) + (stats.tasks?.in_progress || 0) : null, color: '#6366f1', icon: '◆' },
    { label: 'Concluídas', value: stats?.tasks?.done ?? null, color: '#22c55e', icon: '✓' },
    { label: 'Conversas', value: stats?.conversations?.active ?? null, color: '#818cf8', icon: '◉' },
    { label: 'Clientes', value: stats?.clients?.active ?? null, color: '#f59e0b', icon: '■' },
  ]

  return (
    <div className="grid grid-cols-4 gap-3">
      {cards.map(({ label, value, color, icon }) => (
        <div key={label} className="bg-slate-800/40 border border-slate-700/30 rounded-xl px-4 py-3.5 hover:bg-slate-800/60 transition-colors">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[11px]" style={{ color }}>{icon}</span>
            <span className="text-[11px] text-slate-500 font-medium">{label}</span>
          </div>
          <p className="text-2xl font-bold text-slate-100 tabular-nums">
            <AnimatedNumber value={value} />
          </p>
        </div>
      ))}
    </div>
  )
}
