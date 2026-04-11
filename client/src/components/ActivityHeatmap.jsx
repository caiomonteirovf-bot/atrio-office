import { useState, useEffect } from 'react'

export default function ActivityHeatmap() {
  const [data, setData] = useState({ heatmap: [], today: {} })
  const [tooltip, setTooltip] = useState(null)

  useEffect(() => {
    fetch('/api/analytics/activity')
      .then(r => r.json())
      .then(setData)
      .catch(console.error)
  }, [])

  // Build 52 weeks x 7 days grid
  const today = new Date()
  const grid = []
  const dataMap = {}
  data.heatmap.forEach(d => { dataMap[d.date] = d.count })

  // Start from 364 days ago (52 weeks)
  const start = new Date(today)
  start.setDate(start.getDate() - 363)
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay())

  for (let w = 0; w < 53; w++) {
    const week = []
    for (let d = 0; d < 7; d++) {
      const date = new Date(start)
      date.setDate(date.getDate() + w * 7 + d)
      const key = date.toISOString().split('T')[0]
      const count = dataMap[key] || 0
      const isFuture = date > today
      week.push({ date: key, count, isFuture })
    }
    grid.push(week)
  }

  const maxCount = Math.max(...data.heatmap.map(d => d.count), 1)

  function getColor(count, isFuture) {
    if (isFuture) return 'transparent'
    if (count === 0) return 'rgba(255,255,255,0.03)'
    const intensity = Math.min(count / maxCount, 1)
    // Gold scale: from dim to saturated
    if (intensity < 0.25) return 'rgba(196,149,106,0.15)'
    if (intensity < 0.5) return 'rgba(196,149,106,0.35)'
    if (intensity < 0.75) return 'rgba(196,149,106,0.6)'
    return 'rgba(196,149,106,0.9)'
  }

  const days = ['Dom','','Ter','','Qui','','Sab']

  const totalActivity = data.heatmap.reduce((sum, d) => sum + d.count, 0)

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(19,22,32,0.8) 0%, rgba(19,22,32,0.6) 100%)',
      backdropFilter: 'blur(12px)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 12,
      padding: '20px 24px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ color: 'rgba(255,255,255,0.85)', fontSize: 15, fontWeight: 600, margin: 0 }}>
            Atividade da Equipe
          </h3>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, margin: '4px 0 0' }}>
            {totalActivity} ações nos últimos 12 meses
          </p>
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: '#C4956A', fontSize: 18, fontWeight: 700 }}>{data.today.tasks_today || 0}</div>
            <div style={{ color: 'rgba(255,255,255,0.5)' }}>Tasks hoje</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: '#C4956A', fontSize: 18, fontWeight: 700 }}>{data.today.messages_today || 0}</div>
            <div style={{ color: 'rgba(255,255,255,0.5)' }}>Msgs hoje</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ color: '#22c55e', fontSize: 18, fontWeight: 700 }}>{data.today.completed_today || 0}</div>
            <div style={{ color: 'rgba(255,255,255,0.5)' }}>Concluídas</div>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div style={{ display: 'flex', gap: 2, position: 'relative' }}>
        {/* Day labels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 4, paddingTop: 16 }}>
          {days.map((d, i) => (
            <div key={i} style={{ height: 11, width: 24, fontSize: 9, color: 'rgba(255,255,255,0.35)', display: 'flex', alignItems: 'center' }}>
              {d}
            </div>
          ))}
        </div>

        {/* Weeks */}
        <div style={{ display: 'flex', gap: 2, flex: 1, overflow: 'hidden' }}>
          {grid.map((week, wi) => (
            <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {week.map((day, di) => (
                <div
                  key={di}
                  onMouseEnter={(e) => !day.isFuture && setTooltip({ ...day, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setTooltip(null)}
                  style={{
                    width: 11,
                    height: 11,
                    borderRadius: 2,
                    background: getColor(day.count, day.isFuture),
                    cursor: day.isFuture ? 'default' : 'pointer',
                    transition: 'all 0.15s',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 8 }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginRight: 4 }}>Menos</span>
        {[0, 0.15, 0.35, 0.6, 0.9].map((a, i) => (
          <div key={i} style={{ width: 11, height: 11, borderRadius: 2, background: i === 0 ? 'rgba(255,255,255,0.03)' : `rgba(196,149,106,${a})` }} />
        ))}
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginLeft: 4 }}>Mais</span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'fixed',
          left: tooltip.x + 10,
          top: tooltip.y - 40,
          background: '#1a1d28',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 11,
          color: 'rgba(255,255,255,0.85)',
          zIndex: 9999,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          <strong>{tooltip.count}</strong> ações em {tooltip.date}
        </div>
      )}
    </div>
  )
}
