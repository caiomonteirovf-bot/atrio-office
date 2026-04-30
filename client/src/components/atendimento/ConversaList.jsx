import { useEffect, useState, useMemo } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { fetchConversations, formatPhone, formatRelativeTime } from './atendimento-api'

/**
 * Lista de conversas (sidebar esquerda no desktop / tela cheia no mobile).
 *
 * Props:
 *  - selectedId: uuid da conversa ativa
 *  - onSelect: fn(conversation)
 *  - lastWsMessage: evento WS pra refresh
 *  - refreshToken: qualquer mudanca forca reload
 */
export default function ConversaList({ selectedId, onSelect, lastWsMessage, refreshToken }) {
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all') // all | aguardando | resolvidas

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const rows = await fetchConversations({ history: true })
      setConversations(rows)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [refreshToken])

  // Refresh em eventos WS relevantes + poll de 30s como fallback
  useEffect(() => {
    const relevantTypes = new Set([
      'whatsapp_message', 'conversation_updated', 'whatsapp_escalation',
      'whatsapp_conversation_analysis',
    ])
    if (lastWsMessage && relevantTypes.has(lastWsMessage.type)) {
      load()
    }
  }, [lastWsMessage])

  useEffect(() => {
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return conversations.filter(c => {
      if (filter === 'aguardando' && (c.resolved || c.human_replied)) return false
      if (filter === 'resolvidas' && !c.resolved) return false
      if (!term) return true
      const hay = `${c.client_name || ''} ${c.phone || ''} ${c.display_phone || ''} ${c.real_phone || ''} ${c.last_message || ''}`.toLowerCase()
      return hay.includes(term)
    })
  }, [conversations, q, filter])

  const waitingCount = conversations.filter(c => !c.resolved && !c.human_replied).length

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--ao-card)', borderRight: '1px solid var(--ao-border)',
      minWidth: 0,
    }}>
      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--ao-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, color: 'var(--ao-text-primary)' }}>
            Conversas
          </h3>
          {waitingCount > 0 && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444',
            }}>
              {waitingCount} aguardando
            </span>
          )}
        </div>
        {/* Busca */}
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: 8, opacity: 0.5 }} />
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Buscar cliente ou número..."
            style={{
              width: '100%', padding: '6px 8px 6px 26px',
              fontSize: 12, borderRadius: 6,
              border: '1px solid var(--ao-border)',
              background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
            }}
          />
        </div>
        {/* Filtros */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            ['all', 'Todas'],
            ['aguardando', 'Aguardando'],
            ['resolvidas', 'Resolvidas'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              style={{
                flex: 1, padding: '4px 6px', fontSize: 10.5, fontWeight: 600,
                borderRadius: 5, border: '1px solid var(--ao-border)',
                background: filter === id ? 'var(--ao-accent, #c4956a)' : 'transparent',
                color: filter === id ? '#fff' : 'var(--ao-text-secondary)',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Lista */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && conversations.length === 0 && (
          <div style={{ textAlign: 'center', padding: 20, opacity: 0.5 }}>
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
        {error && (
          <div style={{ padding: 10, fontSize: 11, color: '#ef4444' }}>
            Erro: {error}
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 30, opacity: 0.4, fontSize: 12 }}>
            {q ? 'Nenhuma conversa casou com a busca' : 'Nenhuma conversa no momento'}
          </div>
        )}
        {filtered.map(c => {
          const active = c.id === selectedId
          const isWaiting = !c.resolved && !c.human_replied
          const name = c.client_name || c.display_phone || formatPhone(c.phone) || 'Sem nome'
          const preview = (c.last_message || '').slice(0, 80)
          const time = formatRelativeTime(c.last_message_at || c.started_at)

          return (
            <button
              key={c.id}
              onClick={() => onSelect?.(c)}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: '10px 12px', borderBottom: '1px solid var(--ao-border)',
                background: active ? 'var(--ao-surface)' : 'transparent',
                borderLeft: active ? '3px solid var(--ao-accent, #c4956a)' : '3px solid transparent',
                display: 'flex', gap: 9, alignItems: 'flex-start',
                color: 'var(--ao-text-primary)',
                border: 'none', borderBottom: '1px solid var(--ao-border)',
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: c.is_group ? 8 : '50%',
                background: c.is_group ? 'linear-gradient(135deg, #3B82F6, #1D4ED8)'
                  : isWaiting ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                  : 'linear-gradient(135deg, #64748b, #475569)',
                color: '#fff', fontSize: 11, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {c.is_group ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                ) : name.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12.5, fontWeight: 600, marginBottom: 2,
                }}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {name}
                  </span>
                  {time && <span style={{ fontSize: 10, opacity: 0.5, fontWeight: 400 }}>{time}</span>}
                </div>
                {preview && (
                  <div style={{
                    fontSize: 11, color: 'var(--ao-text-dim)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {preview}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                  {c.is_group && (
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 4,
                      background: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.3px',
                    }}>
                      grupo
                    </span>
                  )}
                  {isWaiting && !c.is_group && (
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 4,
                      background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', fontWeight: 700,
                    }}>
                      aguardando
                    </span>
                  )}
                  {c.resolved && (
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 4,
                      background: 'rgba(16, 185, 129, 0.15)', color: '#10B981', fontWeight: 700,
                    }}>
                      ✓ resolvida
                    </span>
                  )}
                  {c.escalation_level >= 2 && !c.resolved && (
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 4,
                      background: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B', fontWeight: 700,
                    }}>
                      crítica
                    </span>
                  )}
                  {c.contact_type && (() => {
                    const meta = {
                      equipe:          { label: 'equipe',     bg: 'rgba(6, 182, 212, 0.15)',  fg: '#06B6D4' },
                      parceiro:        { label: 'parceiro',   bg: 'rgba(139, 92, 246, 0.15)', fg: '#8B5CF6' },
                      fornecedor:      { label: 'fornecedor', bg: 'rgba(245, 158, 11, 0.15)', fg: '#F59E0B' },
                      prospect:        { label: 'prospect',   bg: 'rgba(16, 185, 129, 0.15)', fg: '#10B981' },
                      pessoal:         { label: 'pessoal',    bg: 'rgba(100, 116, 139, 0.18)', fg: '#94A3B8' },
                      cliente_externo: { label: 'externo',    bg: 'rgba(59, 130, 246, 0.15)', fg: '#3B82F6' },
                      spam:            { label: 'spam',       bg: 'rgba(239, 68, 68, 0.15)', fg: '#EF4444' },
                    }[c.contact_type]
                    if (!meta) return null
                    return (
                      <span style={{
                        fontSize: 9, padding: '1px 5px', borderRadius: 4,
                        background: meta.bg, color: meta.fg, fontWeight: 700,
                        textTransform: 'uppercase', letterSpacing: '0.3px',
                      }}>
                        {meta.label}
                      </span>
                    )
                  })()}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
