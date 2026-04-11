import { useState, useEffect } from 'react'

export default function SessionHistory() {
  const [sessions, setSessions] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ agent: '', channel: '', status: '' })
  const [agents, setAgents] = useState([])
  const [expandedId, setExpandedId] = useState(null)
  const [messages, setMessages] = useState({})
  const [page, setPage] = useState(0)
  const LIMIT = 20

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAgents(d.agents || d || []))
  }, [])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (filters.agent) params.set('agent', filters.agent)
    if (filters.channel) params.set('channel', filters.channel)
    if (filters.status) params.set('status', filters.status)
    params.set('limit', LIMIT)
    params.set('offset', page * LIMIT)

    fetch(`/api/sessions?${params}`)
      .then(r => r.json())
      .then(d => {
        setSessions(d.sessions || [])
        setTotal(d.total || 0)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [filters, page])

  const loadMessages = async (sessionId) => {
    if (expandedId === sessionId) { setExpandedId(null); return }
    if (!messages[sessionId]) {
      const res = await fetch(`/api/sessions/${sessionId}/messages`)
      const data = await res.json()
      setMessages(prev => ({ ...prev, [sessionId]: data.messages || [] }))
    }
    setExpandedId(sessionId)
  }

  const formatDate = (d) => {
    if (!d) return '—'
    return new Date(d).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit'
    })
  }

  const formatTokens = (v) => {
    const n = parseInt(v || 0)
    if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`
    if (n >= 1000) return `${(n/1000).toFixed(1)}K`
    return n.toString()
  }

  const channelColors = {
    whatsapp: '#22c55e',
    chat: '#60a5fa',
    email: '#a78bfa',
    internal: '#C4956A',
  }

  const statusColors = {
    active: '#22c55e',
    closed: 'rgba(255,255,255,0.35)',
    pending: '#fbbf24',
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ color: 'rgba(255,255,255,0.85)', fontSize: 20, fontWeight: 700, margin: 0 }}>
          💬 Histórico de Sessões
        </h2>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, margin: '4px 0 0' }}>
          {total} conversas registradas
        </p>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 20,
        background: 'linear-gradient(135deg, rgba(19,22,32,0.8) 0%, rgba(19,22,32,0.6) 100%)',
        backdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 12, padding: '14px 18px',
      }}>
        <select
          value={filters.agent}
          onChange={e => { setFilters(f => ({ ...f, agent: e.target.value })); setPage(0) }}
          style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: '6px 12px', color: 'rgba(255,255,255,0.8)',
            fontSize: 12, outline: 'none', minWidth: 150,
          }}
        >
          <option value="">Todos os agentes</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>

        <select
          value={filters.channel}
          onChange={e => { setFilters(f => ({ ...f, channel: e.target.value })); setPage(0) }}
          style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: '6px 12px', color: 'rgba(255,255,255,0.8)',
            fontSize: 12, outline: 'none',
          }}
        >
          <option value="">Todos os canais</option>
          <option value="chat">Chat</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="email">Email</option>
          <option value="internal">Interno</option>
        </select>

        <select
          value={filters.status}
          onChange={e => { setFilters(f => ({ ...f, status: e.target.value })); setPage(0) }}
          style={{
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: '6px 12px', color: 'rgba(255,255,255,0.8)',
            fontSize: 12, outline: 'none',
          }}
        >
          <option value="">Todos os status</option>
          <option value="active">Ativa</option>
          <option value="closed">Encerrada</option>
          <option value="pending">Pendente</option>
        </select>
      </div>

      {/* Sessions List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'rgba(255,255,255,0.5)' }}>Carregando...</div>
      ) : sessions.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 60,
          background: 'linear-gradient(135deg, rgba(19,22,32,0.8) 0%, rgba(19,22,32,0.6) 100%)',
          backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 12, color: 'rgba(255,255,255,0.4)', fontSize: 14,
        }}>
          Nenhuma sessão encontrada
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map(s => (
            <div key={s.id} style={{
              background: 'linear-gradient(135deg, rgba(19,22,32,0.8) 0%, rgba(19,22,32,0.6) 100%)',
              backdropFilter: 'blur(12px)',
              border: `1px solid ${expandedId === s.id ? 'rgba(196,149,106,0.2)' : 'rgba(255,255,255,0.06)'}`,
              borderRadius: 10, overflow: 'hidden', transition: 'all 0.2s',
            }}>
              {/* Session row */}
              <div
                onClick={() => loadMessages(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
                  cursor: 'pointer',
                }}
              >
                {/* Agent avatar */}
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'rgba(196,149,106,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 700, color: '#C4956A', flexShrink: 0,
                }}>
                  {(s.agent_name || '?')[0]}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: 600 }}>
                      {s.agent_name || 'Desconhecido'}
                    </span>
                    {s.client_name && (
                      <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
                        → {s.client_name}
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 2 }}>
                    {s.agent_role || ''}
                  </div>
                </div>

                {/* Channel badge */}
                <div style={{
                  padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                  textTransform: 'uppercase',
                  background: `${channelColors[s.channel] || '#666'}20`,
                  color: channelColors[s.channel] || '#666',
                }}>
                  {s.channel || '—'}
                </div>

                {/* Stats */}
                <div style={{ textAlign: 'right', minWidth: 60 }}>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{s.message_count || 0} msgs</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{formatTokens(s.total_tokens)} tok</div>
                </div>

                {/* Status dot */}
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: statusColors[s.status] || 'rgba(255,255,255,0.2)',
                  flexShrink: 0,
                }} />

                {/* Date */}
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', minWidth: 100, textAlign: 'right' }}>
                  {formatDate(s.updated_at || s.created_at)}
                </div>

                {/* Expand arrow */}
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, transition: 'transform 0.2s', transform: expandedId === s.id ? 'rotate(90deg)' : 'none' }}>
                  ▶
                </span>
              </div>

              {/* Expanded messages */}
              {expandedId === s.id && messages[s.id] && (
                <div style={{
                  borderTop: '1px solid rgba(255,255,255,0.06)',
                  padding: '12px 18px', maxHeight: 300, overflowY: 'auto',
                }}>
                  {messages[s.id].length === 0 ? (
                    <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12, textAlign: 'center', padding: 12 }}>
                      Sem mensagens
                    </div>
                  ) : messages[s.id].map((m, i) => (
                    <div key={m.id || i} style={{
                      display: 'flex', gap: 10, marginBottom: 10,
                      flexDirection: m.role === 'assistant' ? 'row' : 'row-reverse',
                    }}>
                      <div style={{
                        maxWidth: '75%',
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: m.role === 'assistant' ? 'rgba(196,149,106,0.1)' : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${m.role === 'assistant' ? 'rgba(196,149,106,0.15)' : 'rgba(255,255,255,0.04)'}`,
                      }}>
                        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
                          {m.role === 'assistant' ? s.agent_name : m.role === 'user' ? 'Usuário' : m.role}
                          {' · '}{formatDate(m.created_at)}
                        </div>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {(m.content || '').substring(0, 500)}{(m.content || '').length > 500 ? '...' : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{
                  padding: '6px 14px', borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: page === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)',
                  fontSize: 12, cursor: page === 0 ? 'default' : 'pointer',
                }}
              >
                ← Anterior
              </button>
              <span style={{ padding: '6px 14px', fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                style={{
                  padding: '6px 14px', borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: page >= totalPages - 1 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.7)',
                  fontSize: 12, cursor: page >= totalPages - 1 ? 'default' : 'pointer',
                }}
              >
                Próximo →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
