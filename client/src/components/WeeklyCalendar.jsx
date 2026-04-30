// build-bust: 1777515659
/**
 * WeeklyCalendar do Átrio Office.
 *
 * Desde 29/abr/2026, o CALENDÁRIO É UNIFICADO no Gesthub (fonte única).
 * Esse componente consome /api/calendar do Gesthub via cross-origin.
 * Formulário traz Cliente + Contato (cascata) e Colaborador.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'

// Fonte única: Gesthub. Editar AQUI quando IP mudar.
const GESTHUB_API = 'http://31.97.175.200/api'

const HOURS = Array.from({ length: 17 }, (_, i) => i + 6) // 6h to 22h
const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

const TYPE_COLORS = {
  prazo_fiscal: '#60A5FA',
  task: '#C4956A',
  reuniao: '#A78BFA',
  atividade: '#34D399',
  ligacao: '#FBBF24',
  pessoal: '#F472B6',
  default: '#94A3B8',
}
const CATEGORY_ICONS = {
  fiscal: '📋', pessoal: '👤', contabil: '📊',
  financeiro: '💰', comercial: '🤝', legal: '📑', rh: '👔', geral: '📌',
}

// Adapter: converte camelCase do Gesthub pro shape interno (snake_case usado no render)
function fromGesthub(e) {
  return {
    id: e.id,
    title: e.title,
    description: e.description || '',
    start_time: e.startTime,
    end_time: e.endTime,
    all_day: !!e.allDay,
    type: e.type,
    category: e.category,
    color: e.color,
    cliente_id: e.clienteId,
    contato_id: e.contatoId,
    colaborador_id: e.colaboradorId,
    cliente_nome: e.clienteNome,
    contato_nome: e.contatoNome,
    colaborador_nome: e.colaboradorNome,
    status: e.status,
  }
}

export default function WeeklyCalendar() {
  const [events, setEvents] = useState([])
  const [weekOffset, setWeekOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newEvent, setNewEvent] = useState({
    title: '', type: 'task', category: 'fiscal',
    start_time: '', end_time: '', all_day: false, color: '',
    cliente_id: '', contato_id: '', colaborador_id: '',
  })
  // Refs auxiliares (consumidos do Gesthub)
  const [clientes, setClientes] = useState([])
  const [colaboradores, setColaboradores] = useState([])
  const [contatosDoCliente, setContatosDoCliente] = useState([])

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

  const refreshEvents = useCallback(() => {
    setLoading(true)
    const start = weekDays[0].toISOString().slice(0, 19)
    const end   = new Date(weekDays[6].getTime() + 86400000).toISOString().slice(0, 19)
    fetch(`${GESTHUB_API}/calendar?start=${start}&end=${end}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) setEvents((d.data || []).map(fromGesthub))
        setLoading(false)
      })
      .catch(err => {
        console.error('Falha ao carregar calendar do Gesthub:', err)
        setLoading(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset])

  useEffect(() => { refreshEvents() }, [refreshEvents])

  // Carregar refs (clientes + colaboradores) uma vez
  useEffect(() => {
    fetch(`${GESTHUB_API}/clients`).then(r => r.json()).then(r => {
      if (r.ok) setClientes((r.data || []).slice(0, 500))
    }).catch(() => {})
    fetch(`${GESTHUB_API}/colaboradores?ativo=true`).then(r => r.json()).then(r => {
      if (r.ok) setColaboradores(r.data || [])
    }).catch(() => {})
  }, [])

  // Cascata: ao mudar cliente do form, carregar contatos
  useEffect(() => {
    if (!newEvent.cliente_id) {
      setContatosDoCliente([])
      return
    }
    fetch(`${GESTHUB_API}/calendar/contatos/${newEvent.cliente_id}`)
      .then(r => r.json())
      .then(r => { if (r.ok) setContatosDoCliente(r.data || []) })
      .catch(() => setContatosDoCliente([]))
  }, [newEvent.cliente_id])

  // Feriados (mantém endpoint local do Office — eles já existem)
  const [feriadosMap, setFeriadosMap] = useState({})
  useEffect(() => {
    const anos = new Set([weekDays[0].getFullYear(), weekDays[6].getFullYear()])
    Promise.all(
      [...anos].map(ano =>
        fetch(`/api/feriados?ano=${ano}`).then(r => r.json()).catch(() => ({ feriados: [] }))
      )
    ).then(results => {
      const map = {}
      for (const r of results) {
        for (const f of (r.feriados || [])) {
          if (f.tipo !== 'facultativo') map[f.data] = f
        }
      }
      setFeriadosMap(map)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOffset])

  const getFeriadoForDay = (day) => {
    const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    return feriadosMap[ymd] || null
  }

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
    if (!newEvent.title || !newEvent.start_time) {
      alert('Título e data inicial são obrigatórios')
      return
    }
    const body = {
      title: newEvent.title,
      startTime: newEvent.start_time,
      endTime: newEvent.end_time || null,
      allDay: !!newEvent.all_day,
      type: newEvent.type,
      category: newEvent.category,
      color: newEvent.color || null,
      clienteId: newEvent.cliente_id ? +newEvent.cliente_id : null,
      contatoId: newEvent.contato_id ? +newEvent.contato_id : null,
      colaboradorId: newEvent.colaborador_id ? +newEvent.colaborador_id : null,
    }
    const r = await fetch(`${GESTHUB_API}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json())
    if (!r.ok) {
      alert('Erro: ' + (r.error || 'falha ao criar evento'))
      return
    }
    setShowCreate(false)
    setNewEvent({
      title: '', type: 'task', category: 'fiscal',
      start_time: '', end_time: '', all_day: false, color: '',
      cliente_id: '', contato_id: '', colaborador_id: '',
    })
    refreshEvents()
  }

  const handleDelete = async (id) => {
    if (!confirm('Excluir evento?')) return
    await fetch(`${GESTHUB_API}/calendar/${id}`, { method: 'DELETE' })
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
            Prazos, tarefas e reuniões — fonte única no Gesthub
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

      {loading && (
        <p style={{ color: 'var(--ao-text-muted)', fontSize: 12, textAlign: 'center', padding: 12 }}>
          carregando do Gesthub...
        </p>
      )}

      {/* All-day events row */}
      <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(7, 1fr)', gap: 1, marginBottom: 2 }}>
        <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', padding: '4px 0', textAlign: 'center' }}>dia todo</div>
        {weekDays.map((day, i) => {
          const dayEvents = getEventsForDay(day).filter(e => e.all_day)
          const feriado = getFeriadoForDay(day)
          return (
            <div key={i} style={{ minHeight: 28, padding: '2px 4px' }}>
              {feriado && (
                <div title={feriado.nome} style={{
                  padding: '3px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                  background: 'rgba(220,38,38,0.18)', color: '#FCA5A5',
                  marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  border: '1px solid rgba(220,38,38,0.4)',
                }}>🇧🇷 {feriado.nome}</div>
              )}
              {dayEvents.map(e => {
                const c = e.color || TYPE_COLORS[e.type] || TYPE_COLORS.default
                const realizada = e.realizada
                const opacity = realizada === false ? 0.55 : 1
                const lineThrough = realizada === false ? 'line-through' : 'none'
                return (
                <div key={e.id} onClick={() => setSelectedEvent(e)} style={{
                  padding: '4px 8px', borderRadius: 5, fontSize: 10, fontWeight: 700,
                  background: `linear-gradient(135deg, ${c}33 0%, ${c}1a 100%)`,
                  border: `1px solid ${c}66`, borderLeft: `3px solid ${c}`,
                  color: 'var(--ao-text)', cursor: 'pointer', marginBottom: 3,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  opacity, textDecoration: lineThrough,
                  transition: 'transform .12s ease, box-shadow .12s ease',
                }}
                  onMouseEnter={ev => { ev.currentTarget.style.transform = 'translateY(-1px)'; ev.currentTarget.style.boxShadow = `0 4px 10px ${c}33` }}
                  onMouseLeave={ev => { ev.currentTarget.style.transform = ''; ev.currentTarget.style.boxShadow = '' }}
                >
                  <span style={{ marginRight: 4 }}>{CATEGORY_ICONS[e.category] || '📌'}</span>
                  {realizada === true && <span style={{ color: '#22C55E', marginRight: 4 }}>✓</span>}
                  {e.title}
                </div>
              )})}
            </div>
          )
        })}
      </div>

      {/* Calendar grid */}
      <div style={{ background: 'var(--ao-card)', backdropFilter: 'blur(12px)', border: '1px solid var(--ao-border)', borderRadius: 12, overflow: 'hidden' }}>
        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(7, 1fr)', borderBottom: '1px solid var(--ao-border)' }}>
          <div />
          {weekDays.map((day, i) => {
            const isToday = day.getTime() === today.getTime()
            const feriado = getFeriadoForDay(day)
            const isFeriado = !!feriado
            return (
              <div key={i} title={feriado ? `Feriado: ${feriado.nome}` : undefined} style={{
                padding: '10px 8px', textAlign: 'center', borderLeft: '1px solid var(--ao-input-bg)',
                background: isFeriado ? 'rgba(220,38,38,0.07)' : 'transparent',
              }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: isFeriado ? '#FCA5A5' : 'var(--ao-text-dim)' }}>
                  {DAY_NAMES[day.getDay()]}{isFeriado && ' 🇧🇷'}
                </div>
                <div style={{
                  fontSize: 18, fontWeight: 700, marginTop: 2, fontFamily: 'Space Grotesk',
                  color: isToday ? '#C4956A' : (isFeriado ? '#FCA5A5' : 'var(--ao-text-primary)'),
                  ...(isToday ? { background: 'rgba(196,149,106,0.15)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '2px auto 0' } : {}),
                }}>{day.getDate()}</div>
              </div>
            )
          })}
        </div>

        {/* Time grid */}
        <div style={{ position: 'relative', height: HOURS.length * 48, overflow: 'auto', maxHeight: 500 }}>
          {HOURS.map((hour, i) => (
            <div key={hour} style={{
              position: 'absolute', top: i * 48, left: 0, right: 0,
              display: 'grid', gridTemplateColumns: '50px repeat(7, 1fr)',
              borderBottom: '1px solid var(--ao-separator)', height: 48,
            }}>
              <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', textAlign: 'right', paddingRight: 8, paddingTop: 2 }}>{`${hour}:00`}</div>
              {weekDays.map((_, di) => (
                <div key={di} style={{ borderLeft: '1px solid var(--ao-input-bg)' }} />
              ))}
            </div>
          ))}

          {weekDays.map((day, dayIdx) => {
            const dayEvents = getEventsForDay(day).filter(e => !e.all_day)
            return dayEvents.map(event => {
              const pos = getEventPosition(event)
              const color = event.color || TYPE_COLORS[event.type] || TYPE_COLORS.default
              const realizada = event.realizada
              const opacity = realizada === false ? 0.55 : 1
              const lineThrough = realizada === false ? 'line-through' : 'none'
              return (
                <div key={event.id} onClick={() => setSelectedEvent(event)} style={{
                  position: 'absolute', top: pos.top,
                  left: `calc(50px + ${dayIdx} * ((100% - 50px) / 7) + 4px)`,
                  width: `calc((100% - 50px) / 7 - 8px)`, minHeight: 40,
                  padding: '5px 9px', borderRadius: 6,
                  background: `linear-gradient(135deg, ${color}33 0%, ${color}1a 100%)`,
                  border: `1px solid ${color}55`, borderLeft: `3px solid ${color}`,
                  boxShadow: `0 1px 0 ${color}22 inset`,
                  cursor: 'pointer', zIndex: 2, transition: 'all 0.15s ease',
                  opacity,
                }}
                  onMouseEnter={ev => { ev.currentTarget.style.transform = 'translateY(-1px)'; ev.currentTarget.style.boxShadow = `0 4px 12px ${color}33, 0 1px 0 ${color}22 inset` }}
                  onMouseLeave={ev => { ev.currentTarget.style.transform = ''; ev.currentTarget.style.boxShadow = `0 1px 0 ${color}22 inset` }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ao-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: lineThrough }}>
                    {realizada === true && <span style={{ color: '#22C55E', marginRight: 4 }}>✓</span>}
                    {event.title}
                  </div>
                  <div style={{ fontSize: 10, marginTop: 2, display: 'flex', gap: 5, alignItems: 'center' }}>
                    <span style={{ color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {new Date(event.start_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {event.cliente_nome && <span style={{ color: 'var(--ao-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {event.cliente_nome.slice(0, 20)}</span>}
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
            width: 440, background: 'var(--ao-card)', borderRadius: 12,
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
                }}>{selectedEvent.type}</div>
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
              <div style={{ fontSize: 12, color: 'var(--ao-text-muted)', marginBottom: 8 }}>
                🕐 {new Date(selectedEvent.start_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                {selectedEvent.end_time && ` — ${new Date(selectedEvent.end_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
              </div>
            )}
            {selectedEvent.cliente_nome && (
              <div style={{ fontSize: 12, color: 'var(--ao-text-muted)', marginBottom: 4 }}>
                🏢 Cliente: <strong>{selectedEvent.cliente_nome}</strong>
              </div>
            )}
            {selectedEvent.contato_nome && (
              <div style={{ fontSize: 12, color: 'var(--ao-text-muted)', marginBottom: 4 }}>
                👤 Contato: <strong>{selectedEvent.contato_nome}</strong>
              </div>
            )}
            {selectedEvent.colaborador_nome && (
              <div style={{ fontSize: 12, color: 'var(--ao-text-muted)', marginBottom: 12 }}>
                👥 Responsável: <strong>{selectedEvent.colaborador_nome}</strong>
              </div>
            )}
            {/* TEMP DISABLED: <EventExtras eventId={selectedEvent.id} onChange={refreshEvents} /> */}

            <button onClick={() => handleDelete(selectedEvent.id)} style={{
              width: '100%', padding: '8px 0', borderRadius: 6,
              border: '1px solid rgba(248,113,113,0.2)', background: 'rgba(248,113,113,0.08)',
              color: '#f87171', fontSize: 12, cursor: 'pointer', marginTop: 8,
            }}>Excluir evento</button>
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
            width: 460, maxHeight: '90vh', overflowY: 'auto',
            background: 'var(--ao-card)', borderRadius: 12,
            border: '1px solid var(--ao-border)', padding: 24,
            boxShadow: '0 24px 60px var(--ao-shadow), 0 0 0 1px rgba(196,149,106,0.08)',
          }}>
            <h3 style={{ color: 'var(--ao-text)', fontSize: 16, fontWeight: 700, margin: '0 0 16px', fontFamily: 'Outfit', letterSpacing: '-0.01em' }}>
              Novo Evento
            </h3>

            <Field label="Título *">
              <input type="text" value={newEvent.title}
                onChange={e => setNewEvent(n => ({ ...n, title: e.target.value }))} style={ipt()} />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Início *">
                <input type="datetime-local" value={newEvent.start_time}
                  onChange={e => {
                    const v = e.target.value
                    setNewEvent(n => {
                      const next = { ...n, start_time: v }
                      if (v) {
                        const sd = new Date(v)
                        const cur = n.end_time ? new Date(n.end_time) : null
                        if (!cur || cur <= sd) {
                          const pad = x => String(x).padStart(2, '0')
                          const e2 = new Date(sd.getTime() + 30*60*1000)
                          next.end_time = `${e2.getFullYear()}-${pad(e2.getMonth()+1)}-${pad(e2.getDate())}T${pad(e2.getHours())}:${pad(e2.getMinutes())}`
                        }
                      }
                      return next
                    })
                  }} style={ipt()} />
              </Field>
              <Field label="Fim">
                <input type="datetime-local" value={newEvent.end_time}
                  onChange={e => setNewEvent(n => ({ ...n, end_time: e.target.value }))} style={ipt()} />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Tipo">
                <select value={newEvent.type} onChange={e => setNewEvent(n => ({ ...n, type: e.target.value }))} style={ipt(true)}>
                  <option value="task">Tarefa</option>
                  <option value="reuniao">Reunião</option>
                  <option value="prazo_fiscal">Prazo Fiscal</option>
                  <option value="atividade">Atividade externa</option>
                  <option value="ligacao">Ligação</option>
                  <option value="outro">Outro</option>
                </select>
              </Field>
              <Field label="Categoria">
                <select value={newEvent.category} onChange={e => setNewEvent(n => ({ ...n, category: e.target.value }))} style={ipt(true)}>
                  <option value="fiscal">Fiscal</option>
                  <option value="pessoal">Pessoal</option>
                  <option value="contabil">Contábil</option>
                  <option value="financeiro">Financeiro</option>
                  <option value="comercial">Comercial</option>
                  <option value="legal">Legal</option>
                  <option value="rh">RH</option>
                  <option value="geral">Geral</option>
                </select>
              </Field>
            </div>

            {/* CLIENTE + CONTATO em cascata */}
            <Field label="Cliente">
              <select value={newEvent.cliente_id}
                onChange={e => setNewEvent(n => ({ ...n, cliente_id: e.target.value, contato_id: '' }))}
                style={ipt(true)}>
                <option value="">— sem cliente —</option>
                {clientes.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.legalName || c.tradeName || c.legal_name || c.trade_name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={
              <>Contato {newEvent.cliente_id && contatosDoCliente.length === 0 &&
                <span style={{ color: 'var(--ao-text-dim)', fontSize: 9, marginLeft: 4 }}>(cliente sem contatos)</span>}
              </>
            }>
              <select value={newEvent.contato_id} disabled={!newEvent.cliente_id}
                onChange={e => setNewEvent(n => ({ ...n, contato_id: e.target.value }))}
                style={ipt(true)}>
                <option value="">{newEvent.cliente_id ? '— sem contato —' : 'escolha cliente primeiro'}</option>
                {contatosDoCliente.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.nome}{c.funcao ? ` (${c.funcao})` : ''}{c.telefone ? ` · ${c.telefone}` : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Responsável (colaborador)">
              <select value={newEvent.colaborador_id}
                onChange={e => setNewEvent(n => ({ ...n, colaborador_id: e.target.value }))}
                style={ipt(true)}>
                <option value="">— ninguém —</option>
                {colaboradores.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </Field>

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

// =============================================================
// Helpers visuais (mantém estilo Office)
// =============================================================
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-muted)', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )
}
function ipt(isSelect = false) {
  return {
    width: '100%', padding: '8px 12px', borderRadius: 6,
    background: 'var(--ao-border)', border: '1px solid var(--ao-border)',
    color: 'var(--ao-text)', fontSize: isSelect ? 12 : 13, outline: 'none',
    boxSizing: 'border-box',
  }
}

// ===========================================================================
// EventExtras (Office) — bloco Realização + Ata + Anexos pra eventos do calendário.
// Usa GESTHUB_API (fonte única). Tema cores do Átrio Office.
// ===========================================================================
function EventExtras({ eventId, onChange }) {
  const [aba, setAba] = useState('realizacao')
  const [evCompleto, setEvCompleto] = useState(null)
  const [ataLocal, setAtaLocal] = useState('')
  const [savingAta, setSavingAta] = useState(false)
  const [files, setFiles] = useState([])
  const [filesLoaded, setFilesLoaded] = useState(false)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (!eventId) return
    fetch(`${GESTHUB_API}/calendar/${eventId}`)
      .then(r => r.json())
      .then(r => {
        if (r.ok) {
          setEvCompleto(r.data)
          setAtaLocal(r.data.ata || '')
        }
      })
  }, [eventId])

  const ev = evCompleto
  if (!ev) return <div style={{ padding: 12, fontSize: 11, color: 'var(--ao-text-muted)' }}>carregando...</div>

  const isFuturo = ev.startTime && new Date(ev.startTime) >= new Date()

  const loadFiles = useCallback(() => {
    fetch(`${GESTHUB_API}/calendar/${eventId}/files`)
      .then(r => r.json())
      .then(r => { if (r.ok) { setFiles(r.data || []); setFilesLoaded(true) } })
      .catch(() => setFilesLoaded(true))
  }, [eventId])

  useEffect(() => { if (aba === 'anexos' && !filesLoaded) loadFiles() }, [aba, filesLoaded, loadFiles])

  const refreshEv = () => {
    fetch(`${GESTHUB_API}/calendar/${eventId}`)
      .then(r => r.json())
      .then(r => { if (r.ok) setEvCompleto(r.data) })
    onChange?.()
  }

  const marcarRealizada = async (status, motivo) => {
    const body = { realizada: status }
    if (status === false) body.motivoNaoRealizada = motivo || ''
    const r = await fetch(`${GESTHUB_API}/calendar/${eventId}/realizada`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())
    if (r.ok) refreshEv()
    else alert(r.error || 'Erro')
  }

  const salvarAta = async () => {
    setSavingAta(true)
    const r = await fetch(`${GESTHUB_API}/calendar/${eventId}/ata`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ata: ataLocal }),
    }).then(r => r.json())
    setSavingAta(false)
    if (r.ok) refreshEv()
    else alert(r.error || 'Erro')
  }

  const handleUpload = async (fileList) => {
    if (!fileList?.length) return
    setUploading(true)
    const fd = new FormData()
    for (const f of fileList) fd.append('files', f)
    const r = await fetch(`${GESTHUB_API}/calendar/${eventId}/files`, { method: 'POST', body: fd }).then(r => r.json())
    setUploading(false)
    if (r.ok) { loadFiles(); onChange?.() }
    else alert(r.detail || r.error || 'Erro upload')
  }

  const deleteFile = async (fid) => {
    if (!confirm('Excluir anexo?')) return
    await fetch(`${GESTHUB_API}/calendar/${eventId}/files/${fid}`, { method: 'DELETE' })
    loadFiles()
    onChange?.()
  }

  return (
    <div style={{
      marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--ao-border)',
    }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid var(--ao-border)' }}>
        <OfAbaBtn active={aba === 'realizacao'} onClick={() => setAba('realizacao')}>
          Realização {ev.realizada === true ? '✓' : ev.realizada === false ? '✗' : ''}
        </OfAbaBtn>
        <OfAbaBtn active={aba === 'ata'} onClick={() => setAba('ata')}>
          Ata {(ev.ata || '').trim() ? '✓' : ''}
        </OfAbaBtn>
        <OfAbaBtn active={aba === 'anexos'} onClick={() => setAba('anexos')}>
          Anexos {ev.filesCount ? `(${ev.filesCount})` : ''}
        </OfAbaBtn>
      </div>

      {aba === 'realizacao' && (
        <div style={{
          padding: 10, borderRadius: 6, background: 'var(--ao-input-bg)',
          border: '1px solid var(--ao-border)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 8, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Esta reunião / evento ocorreu?
          </div>
          {ev.realizada === null && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => marcarRealizada(true)} style={btnExtOf('#22c55e', 'rgba(34,197,94,0.15)')}>✓ Sim, ocorreu</button>
              <button onClick={() => {
                const m = prompt('Motivo (cancelada, no-show, remarcada...):', '')
                if (m !== null) marcarRealizada(false, m)
              }} style={btnExtOf('#f87171', 'rgba(248,113,113,0.15)')}>✗ Não ocorreu</button>
              {isFuturo && <span style={{ fontSize: 10, color: 'var(--ao-text-dim)', alignSelf: 'center', marginLeft: 6 }}>(você pode confirmar depois)</span>}
            </div>
          )}
          {ev.realizada === true && (
            <div style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>
              ✓ Confirmada {ev.realizadaEm && `em ${new Date(ev.realizadaEm).toLocaleString('pt-BR')}`}
              {ev.realizadaPor && ` por ${ev.realizadaPor}`}
              <button onClick={() => marcarRealizada(null)} style={{ marginLeft: 10, fontSize: 10, color: 'var(--ao-text-dim)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>desmarcar</button>
            </div>
          )}
          {ev.realizada === false && (
            <div style={{ fontSize: 12, color: '#f87171', fontWeight: 600 }}>
              ✗ Não ocorreu — {ev.motivoNaoRealizada || 'sem motivo informado'}
              <button onClick={() => marcarRealizada(null)} style={{ marginLeft: 10, fontSize: 10, color: 'var(--ao-text-dim)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>desmarcar</button>
            </div>
          )}
        </div>
      )}

      {aba === 'ata' && (
        <div>
          <textarea value={ataLocal} onChange={e => setAtaLocal(e.target.value)}
            placeholder="Registre aqui o que foi discutido, decisões tomadas, próximos passos..."
            rows={8} style={{
              width: '100%', padding: 10, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
              border: '1px solid var(--ao-border)', borderRadius: 6, background: 'var(--ao-input-bg)',
              color: 'var(--ao-text)', resize: 'vertical', outline: 'none',
            }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={salvarAta} disabled={savingAta || ataLocal === (ev.ata || '')}
              style={{
                padding: '6px 16px', background: 'rgba(34,197,94,0.15)', color: '#22c55e',
                borderRadius: 6, border: '1px solid rgba(34,197,94,0.3)', fontSize: 12, fontWeight: 700,
                cursor: ataLocal === (ev.ata || '') ? 'not-allowed' : 'pointer',
                opacity: ataLocal === (ev.ata || '') ? 0.5 : 1,
              }}>{savingAta ? 'Salvando...' : 'Salvar ata'}</button>
          </div>
        </div>
      )}

      {aba === 'anexos' && (
        <div>
          <label style={{
            display: 'inline-block', padding: '6px 14px', background: 'rgba(196,149,106,0.15)',
            color: '#C4956A', border: '1px solid rgba(196,149,106,0.3)',
            borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', marginBottom: 10,
          }}>
            {uploading ? 'Enviando...' : '+ Anexar arquivo'}
            <input type="file" multiple hidden disabled={uploading}
              onChange={e => { handleUpload(e.target.files); e.target.value = '' }} />
          </label>
          {files.length === 0 && filesLoaded && (
            <p style={{ fontSize: 11, color: 'var(--ao-text-dim)', textAlign: 'center', padding: 12 }}>Nenhum anexo.</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {files.map(f => (
              <div key={f.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 10px', background: 'var(--ao-input-bg)', borderRadius: 6,
                border: '1px solid var(--ao-border)', fontSize: 11,
              }}>
                <div>
                  <strong style={{ color: 'var(--ao-text)' }}>{f.fileName}</strong>
                  <span style={{ color: 'var(--ao-text-dim)', marginLeft: 8 }}>
                    {f.sizeBytes ? `${(f.sizeBytes/1024).toFixed(0)} KB` : ''}
                    {f.createdAt && ` · ${new Date(f.createdAt).toLocaleDateString('pt-BR')}`}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {f.url && <a href={f.url} target="_blank" rel="noreferrer" style={{ color: '#C4956A', fontWeight: 600 }}>abrir</a>}
                  <button onClick={() => deleteFile(f.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ao-text-dim)' }}>×</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function OfAbaBtn({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '6px 14px', fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
      background: 'transparent', border: 'none', cursor: 'pointer',
      borderBottom: `2px solid ${active ? '#C4956A' : 'transparent'}`,
      color: active ? '#C4956A' : 'var(--ao-text-dim)', marginBottom: -1,
    }}>{children}</button>
  )
}

function btnExtOf(fg, bg) {
  return {
    padding: '5px 12px', fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
    border: `1px solid ${fg}55`, background: bg, color: fg,
    borderRadius: 6, cursor: 'pointer',
  }
}
