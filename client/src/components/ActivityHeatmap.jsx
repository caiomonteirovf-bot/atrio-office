import { useState, useEffect } from 'react'

export default function ActivityHeatmap() {
  const [data, setData] = useState({ heatmap: [], today: {} })
  const [tooltip, setTooltip] = useState(null)

  useEffect(() => {
    fetch('/api/analytics/activity')
      .then(r => {
        if (!r.ok) throw new Error('API error')
        return r.json()
      })
      .then(d => {
        if (d && Array.isArray(d.heatmap)) setData(d)
      })
      .catch(() => {})
  }, [])

  // Build 52 weeks x 7 days grid
  const today = new Date()
  const grid = []
  const dataMap = {}
  const heatmap = data.heatmap || []
  heatmap.forEach(d => { const key = String(d.date).split('T')[0]; dataMap[key] = d.count })

  // Start from 364 days ago (52 weeks)
  const start = new Date(today)
  start.setDate(start.getDate() - 363)
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay())

  let currentDate = new Date(start)
  let currentWeek = []

  while (currentDate <= today || currentWeek.length > 0) {
    const dateStr = currentDate.toISOString().split('T')[0]
    const isFuture = currentDate > today
    currentWeek.push({
      date: dateStr,
      count: dataMap[dateStr] || 0,
      isFuture,
    })

    if (currentWeek.length === 7) {
      grid.push(currentWeek)
      currentWeek = []
      if (isFuture) break
    }

    currentDate.setDate(currentDate.getDate() + 1)
  }

  const getColor = (count, isFuture) => {
    if (isFuture) return 'transparent'
    if (count === 0) return 'var(--ao-border)'
    if (count <= 2) return 'rgba(196,149,106,0.15)'
    if (count <= 5) return 'rgba(196,149,106,0.35)'
    if (count <= 10) return 'rgba(196,149,106,0.6)'
    return 'rgba(196,149,106,0.9)'
  }

  const todayData = data.today || {}

  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ao-text-primary)', margin: 0 }}>
          Atividade
        </h3>
        <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--ao-text-muted)' }}>
          <span>{todayData.tasks_today || 0} tarefas hoje</span>
          <span>{todayData.messages_today || 0} mensagens</span>
          <span>{todayData.completed_today || 0} concluídas</span>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'flex', gap: 2 }}>
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
        <span style={{ fontSize: 10, color: 'var(--ao-text-dim)', marginRight: 4 }}>Menos</span>
        {[0, 0.15, 0.35, 0.6, 0.9].map((a, i) => (
          <div key={i} style={{ width: 11, height: 11, borderRadius: 2, background: i === 0 ? 'var(--ao-border)' : `rgba(196,149,106,${a})` }} />
        ))}
        <span style={{ fontSize: 10, color: 'var(--ao-text-dim)', marginLeft: 4 }}>Mais</span>
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
          color: 'var(--ao-text-primary)',
          zIndex: 9999,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          <strong>{tooltip.count}</strong> aes em {tooltip.date}
        </div>
      )}
    </div>
  )
}
