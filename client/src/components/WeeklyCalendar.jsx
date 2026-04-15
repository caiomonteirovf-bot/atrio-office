import { useState, useEffect } from 'react'

const HOURS = Array.from({ length: 17 }, (_, i) => i + 6) // 6h to 22h
const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const TYPE_COLORS = {
  prazo_fiscal: '#378ADD',
  task: '#C4956A',
  reuniao: '#a78bfa',
  pessoal: '#D946A8',
  default: '#60a5fa',
}

const CATEGORY_ICONS = {
  fiscal: '📋',
  pessoal: '👤',
  financeiro: '💰',
  comercial: '🤝',
  societario: '📑',
}

export default function WeeklyCalendar() {
  const [events, setEvents] = useState([])
  const [weekOffset, setWeekOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newEvent, setNewEvent] = useState({ title: '', type: 'task', category: 'fiscal', start_time: '', all_day: false, color: '' })

  // Get week start (Monday)
  const getWeekStart = (offset) => {
    const d = new Date()
    d.setDate(d.getDate() - d.getDay() + 1 + offset * 7)
    d.setHours(0, 0, 0, 0)
    return d
  }

  const weekStart = getWeekStart(weekOffset)
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    return d
  })

  useEffect(() => {
    setLoading(true)
    const start = weekDays[0].toISOString()
    const end = new Date(weekDays[6].getTime() + 86400000).toISOString()

    fetch(`/api/calendar?start=${start}&end=${end}`)
      .then(r => r.json())
      .then(d => { setEvents(d.events || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [weekOffset])

  const getEventsForDay = (day) => {
    const dayStr = day.toISOString().split('T')[0]
    return events.filter(e => {
      const eDate = new Date(e.start_time).toISOString().split('T')[0]
      return eDate === dayStr
    })
  }

  const getEventPosition = (event) => {
    if (event.all_day) return { top: 0, isAllDay: true }
    const d = new Date(event.start_time)
    const hour = d.getHours() + d.getMinutes() / 60
    return { top: (hour - 6) * 48, isAllDay: false }
  }

  const handleCreate = async () => {
    if (!newEvent.title || !newEvent.start_time) return
    await fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newEvent)
    })
    setShowCreate(false)
    setNewEvent({ title: '', type: 'task', category: 'fiscal', start_time: '', all_day: false, color: '' })
    // Refresh
    setWeekOffset(w => w) // force re-render
    const start = weekDays[0].toISOString()
    const end = new Date(weekDays[6].getTime() + 86400000).toISOString()
    const res = await fetch(`/api/calendar?start=${start}&end=${end}`)
    const data = await res.json()
    setEvents(data.events || [])
  }

  const handleDelete = async (id) => {
    await fetch(`/api/calendar/${id}`, { method: 'DELETE' })
    setEvents(events.filter(e => e.id !== id))
    setSelectedEvent(null)
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const weekLabel = `${weekDays[0].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} — ${weekDays[6].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}`

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ color: 'var(--ao-text)', fontSize: 20, fontWeight: 700, margin: 0, fontFamily: 'Outfit', letterSpacing: '-0.01em' }}>
            📅 Calendário Semanal
          </h2>
          <p style={{ color: 'var(--ao-text-muted)', fontSize: 13, margin: '4px 0 0' }}>
            Prazos fiscais, tarefas e eventos
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setWeekOffset(w => w - 1)} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--ao-border)', background: 'var(--ao-input-bg)', color: 'var(--ao-text-primary)', fontSize: 13, cursor: 'pointer' }}>←</button>
          <button onClick={() => setWeekOffset(0)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(196,149,106,0.2)', background: 'rgba(196,149,106,0.08)', color: '#C4956A', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Hoje</button>
          <button onClick={() => setWeekOffset(w => w + 1)} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--ao-border)', background: 'var(--ao-input-bg)', color: 'var(--ao-text-primary)', fontSize: 13, cursor: 'pointer' }}>→</button>
          <span style={{ color: 'var(--ao-text)', fontSize: 13, marginLeft: 8, fontWeight: 600, fontFamily: 'Outfit' }}>{weekLabel}</span>
          <button onClick={() => setShowCreate(true)} style={{ marginLeft: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(196,149,106,0.3)', background: 'rgba(196,149,106,0.12)', color: '#C4956A', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>+ Evento</button>
        </div>
      </div>

      {/* All-day events row */}
      <div style={{
        display: 'grid', gridTemplateColumns: '50px repeat(7, 1fr)', gap: 1,
        marginBottom: 2,
      }}>
        <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', padding: '4px 0', textAlign: 'center' }}>dia todo</div>
        {weekDays.map((day, i) => {
          const dayEvents = getEventsForDay(day).filter(e => e.all_day)
          return (
            <div key={i} style={{ minHeight: 28, padding: '2px 4px' }}>
              {dayEvents.map(e => (
                <div key={e.id} onClick={() => setSelectedEvent(e)} style={{
                  padding: '3px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                  background: `${e.color || TYPE_COLORS[e.type] || TYPE_COLORS.default}25`,
                  color: e.color || TYPE_COLORS[e.type] || TYPE_COLORS.default,
                  cursor: 'pointer', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {CATEGORY_ICONS[e.category] || '📌'} {e.title}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Calendar grid */}
      <div style={{
        background: 'var(--ao-card)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--ao-border)',
        borderRadius: 12, overflow: 'hidden',
      }}>
        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(7, 1fr)', borderBottom: '1px solid var(--ao-border)' }}>
          <div />
          {weekDays.map((day, i) => {
            const isToday = day.getTime() === today.getTime()
            return (
              <div key={i} style={{
                padding: '10px 8px', textAlign: 'center',
                borderLeft: '1px solid var(--ao-input-bg)',
              }}>
                <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{DAY_NAMES[day.getDay()]}</div>
                <div style={{
                  fontSize: 18, fontWeight: 700, marginTop: 2, fontFamily: 'Space Grotesk',
                  color: isToday ? '#C4956A' : 'var(--ao-text-primary)',
                  ...(isToday ? { background: 'rgba(196,149,106,0.15)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '2px auto 0' } : {}),
                }}>
                  {day.getDate()}
                </div>
              </div>
            )
          })}
        </div>

        {/* Time grid */}
        <div style={{ position: 'relative', height: HOURS.length * 48, overflow: 'auto', maxHeight: 500 }}>
          {/* Hour lines */}
          {HOURS.map((hour, i) => (
            <div key={hour} style={{
              position: 'absolute', top: i * 48, left: 0, right: 0,
              display: 'grid', gridTemplateColumns: '50px repeat(7, 1fr)',
              borderBottom: '1px solid var(--ao-separator)',
              height: 48,
            }}>
              <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', textAlign: 'right', paddingRight: 8, paddingTop: 2 }}>
                {`${hour}:00`}
              </div>
              {weekDays.map((_, di) => (
                <div key={di} style={{ borderLeft: '1px solid var(--ao-input-bg)' }} />
              ))}
            </div>
          ))}

          {/* Events */}
          {weekDays.map((day, dayIdx) => {
            const dayEvents = getEventsForDay(day).filter(e => !e.all_day)
            return dayEvents.map(event => {
              const pos = getEventPosition(event)
              const color = event.color || TYPE_COLORS[event.type] || TYPE_COLORS.default
              return (
                <div
                  key={event.id}
                  onClick={() => setSelectedEvent(event)}
                  style={{
                    position: 'absolute',
                    top: pos.top,
                    left: `calc(50px + ${dayIdx} * ((100% - 50px) / 7) + 4px)`,
                    width: `calc((100% - 50px) / 7 - 8px)`,
                    minHeight: 40,
                    padding: '4px 8px',
                    borderRadius: 6,
                    background: `${color}20`,
                    borderLeft: `3px solid ${color}`,
                    cursor: 'pointer',
                    zIndex: 2,
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {event.title}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--ao-text-dim)', marginTop: 1 }}>
                    {new Date(event.start_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              )
            })
          })}
        </div>
      </div>

      {/* Event detail modal */}
      {selectedEvent && (
        <div onClick={() => setSelectedEvent(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: 400, background: 'var(--ao-card)', borderRadius: 12,
            border: '1px solid var(--ao-border)', padding: 24,
            boxShadow: '0 24px 60px var(--ao-shadow), 0 0 0 1px rgba(196,149,106,0.08)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <h3 style={{ color: 'var(--ao-text)', fontSize: 16, fontWeight: 700, margin: 0, fontFamily: 'Outfit', letterSpacing: '-0.01em' }}>
                  {selectedEvent.title}
                </h3>
                <div style={{
                  display: 'inline-block', marginTop: 6, padding: '3px 8px', borderRadius: 4,
                  fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                  background: `${selectedEvent.color || TYPE_COLORS[selectedEvent.type] || TYPE_COLORS.default}20`,
                  color: selectedEvent.color || TYPE_COLORS[selectedEvent.type] || TYPE_COLORS.default,
                }}>
                  {selectedEvent.type}
                </div>
              </div>
              <button onClick={() => setSelectedEvent(null)} style={{
                background: 'none', border: 'none', color: 'var(--ao-text-dim)', fontSize: 18, cursor: 'pointer',
              }}>×</button>
            </div>
            {selectedEvent.description && (
              <p style={{ color: 'var(--ao-text-secondary)', fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 }}>
                {selectedEvent.description}
              </p>
            )}
            <div style={{ fontSize: 12, color: 'var(--ao-text-muted)', marginBottom: 4 }}>
              📅 {new Date(selectedEvent.start_time).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            </div>
            {!selectedEvent.all_day && (
              <div style={{ fontSize: 12, color: 'var(--ao-text-muted)', marginBottom: 12 }}>
                🕐 {new Date(selectedEvent.start_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                {selectedEvent.end_time && ` — ${new Date(selectedEvent.end_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
              </div>
            )}
            <button onClick={() => handleDelete(selectedEvent.id)} style={{
              width: '100%', padding: '8px 0', borderRadius: 6,
              border: '1px solid rgba(248,113,113,0.2)', background: 'rgba(248,113,113,0.08)',
              color: '#f87171', fontSize: 12, cursor: 'pointer', marginTop: 8,
            }}>
              Excluir evento
            </button>
          </div>
        </div>
      )}

      {/* Create event modal */}
      {showCreate && (
        <div onClick={() => setShowCreate(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: 420, background: 'var(--ao-card)', borderRadius: 12,
            border: '1px solid var(--ao-border)', padding: 24,
            boxShadow: '0 24px 60px var(--ao-shadow), 0 0 0 1px rgba(196,149,106,0.08)',
          }}>
            <h3 style={{ color: 'var(--ao-text)', fontSize: 16, fontWeight: 700, margin: '0 0 16px', fontFamily: 'Outfit', letterSpacing: '-0.01em' }}>
              Novo Evento
            </h3>
            {[
              { label: 'Título', key: 'title', type: 'text' },
              { label: 'Data/Hora', key: 'start_time', type: 'datetime-local' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-muted)', marginBottom: 4 }}>{f.label}</label>
                <input
                  type={f.type}
                  value={newEvent[f.key]}
                  onChange={e => setNewEvent(n => ({ ...n, [f.key]: e.target.value }))}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6,
                    background: 'var(--ao-border)', border: '1px solid var(--ao-border)',
                    color: 'var(--ao-text)', fontSize: 13, outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-muted)', marginBottom: 4 }}>Tipo</label>
                <select value={newEvent.type} onChange={e => setNewEvent(n => ({ ...n, type: e.target.value }))} style={{
                  width: '100%', padding: '8px 12px', borderRadius: 6,
                  background: 'var(--ao-border)', border: '1px solid var(--ao-border)',
                  color: 'var(--ao-text)', fontSize: 12, outline: 'none',
                }}>
                  <option value="task">Tarefa</option>
                  <option value="prazo_fiscal">Prazo Fiscal</option>
                  <option value="reuniao">Reunião</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-muted)', marginBottom: 4 }}>Categoria</label>
                <select value={newEvent.category} onChange={e => setNewEvent(n => ({ ...n, category: e.target.value }))} style={{
                  width: '100%', padding: '8px 12px', borderRadius: 6,
                  background: 'var(--ao-border)', border: '1px solid var(--ao-border)',
                  color: 'var(--ao-text)', fontSize: 12, outline: 'none',
                }}>
                  <option value="fiscal">Fiscal</option>
                  <option value="pessoal">Pessoal</option>
                  <option value="financeiro">Financeiro</option>
                  <option value="comercial">Comercial</option>
                  <option value="societario">Societário</option>
                </select>
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ao-text-secondary)', marginBottom: 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={newEvent.all_day} onChange={e => setNewEvent(n => ({ ...n, all_day: e.target.checked }))} />
              Dia inteiro
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowCreate(false)} style={{
                flex: 1, padding: '8px 0', borderRadius: 6, border: '1px solid var(--ao-border)',
                background: 'var(--ao-input-bg)', color: 'var(--ao-text-secondary)', fontSize: 12, cursor: 'pointer',
              }}>Cancelar</button>
              <button onClick={handleCreate} style={{
                flex: 1, padding: '8px 0', borderRadius: 6, border: '1px solid rgba(196,149,106,0.3)',
                background: 'rgba(196,149,106,0.15)', color: '#C4956A', fontSize: 12, cursor: 'pointer', fontWeight: 600,
              }}>Criar Evento</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
