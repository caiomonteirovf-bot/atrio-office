// MINIMAL_REDESIGN_v1
import { useEffect, useState, useMemo } from 'react'
import { Search, Loader2, Calendar } from 'lucide-react'
import { fetchConversations, formatPhone, formatRelativeTime, markResolved } from './atendimento-api'

/**
 * Lista de conversas (sidebar esquerda no desktop / tela cheia no mobile).
 *
 * Props:
 *  - selectedId: uuid da conversa ativa
 *  - onSelect: fn(conversation)
 *  - lastWsMessage: evento WS pra refresh
 *  - refreshToken: qualquer mudanca forca reload
 */

// Detecta sinal de fechamento positivo na ultima msg do cliente.
// Mais leve que o detectSelfResolution do backend: nao auto-resolve, so
// rebaixa a tag 'critica' visualmente e sugere marcar como resolvida.
const POSITIVE_CLOSURE_PATTERNS = [
  /\b(muito\s+)?obrigad[oa]\b/i,
  /\bagrade[cç]o\b/i,
  /\bvaleu\b/i,
  /\bvlw\b/i,
  /\bperfeito\b/i,
  /\bshow\b/i,
  /\bresolvido\b/i,
  /\btudo\s+certo\b/i,
  /\bok,?\s*obrigad/i,
  /[\u{1F64F}\u{1F44D}\u{2705}\u{2764}\u{1F44C}]/u,
]
function isPositiveClosure(text) {
  if (!text || typeof text !== 'string') return false
  const clean = text.trim()
  if (!clean || clean.length > 200) return false
  return POSITIVE_CLOSURE_PATTERNS.some(p => p.test(clean))
}


// Paleta de gradientes para avatar — pega 1 par determinístico pelo hash do nome.
// Mesma logica usada em ConversaListNative (Gesthub) pra manter visual consistente.
const NAME_COLORS = [
  ['#F97316', '#EA580C'],
  ['#22D3EE', '#0891B2'],
  ['#7F77DD', '#5B52B6'],
  ['#FBBF24', '#D97706'],
  ['#EC4899', '#BE185D'],
  ['#10B981', '#059669'],
  ['#A855F7', '#7E22CE'],
  ['#EF4444', '#B91C1C'],
  ['#06B6D4', '#0E7490'],
  ['#84CC16', '#4D7C0F'],
]
function colorFromName(name) {
  if (!name) return ['#94A3B8', '#64748B']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return NAME_COLORS[Math.abs(hash) % NAME_COLORS.length]
}

export default function ConversaList({ selectedId, onSelect, lastWsMessage, refreshToken, onOpenToday }) {
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all') // all | aguardando | resolvidas
  const [resolvingId, setResolvingId] = useState(null)

  // Marca conversa como resolvida direto da lista (1-clique no badge ✓ encerrar?).
  // Optimistic: atualiza local imediato, depois confirma com reload via WS/poll.
  const handleInlineResolve = async (e, conv) => {
    e.stopPropagation()
    e.preventDefault()
    if (!conv?.phone || resolvingId) return
    setResolvingId(conv.id)
    // Optimistic update
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, resolved: true } : c))
    try {
      await markResolved(conv.phone)
    } catch (err) {
      console.error('[atendimento] inline resolve falhou:', err)
      // rollback optimistic on failure
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, resolved: conv.resolved } : c))
    } finally {
      setResolvingId(null)
    }
  }

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
      const snoozed = c.snoozed_until && new Date(c.snoozed_until) > new Date()
      // Filtros padrao escondem snoozed (volta automatico quando data chega)
      if (filter === 'all' && snoozed) return false
      if (filter === 'aguardando' && (c.resolved || c.human_replied || snoozed)) return false
      if (filter === 'resolvidas' && !c.resolved) return false
      if (filter === 'snoozed' && !snoozed) return false
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
      {/* Header — saudacao humana + metricas + atalho Hoje */}
      <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--ao-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 15.5, fontWeight: 700, margin: 0, color: 'var(--ao-text-primary)', lineHeight: 1.2 }}>
              {(() => {
                const h = new Date().getHours()
                const greet = h < 6 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
                const emoji = h < 6 ? '🌙' : h < 12 ? '☀️' : h < 18 ? '👋' : '🌆'
                return `${greet} ${emoji}`
              })()}
            </h2>
            <p style={{
              margin: '4px 0 0', fontSize: 11, color: 'var(--ao-text-dim)', lineHeight: 1.5,
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            }}>
              {waitingCount > 0 ? (
                <>
                  <span style={{ color: '#ef4444', fontWeight: 700 }}>{waitingCount}</span>
                  <span>aguardando</span>
                </>
              ) : (
                <span style={{ color: '#10B981', fontWeight: 600 }}>tudo em dia ✓</span>
              )}
              <span style={{ opacity: 0.4 }}>·</span>
              <span>{conversations.length} conversas</span>
            </p>
          </div>
          {onOpenToday && (
            <button
              onClick={onOpenToday}
              title="Resumo do dia: conversas, tasks e extratos"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 10.5, fontWeight: 600,
                padding: '5px 10px', borderRadius: 14,
                border: '1px solid rgba(99, 102, 241, 0.25)',
                background: 'rgba(99, 102, 241, 0.08)',
                color: 'rgba(99, 102, 241, 0.95)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <Calendar size={11} /> Hoje
            </button>
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
            ['snoozed', 'Snooze'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              style={{
                flex: 1, padding: '4px 6px', fontSize: 10.5, fontWeight: 600,
                borderRadius: 5, border: '1px solid var(--ao-border)',
                background: filter === id ? 'var(--ao-accent-bg, rgba(99,102,241,0.10))' : 'transparent',
                borderColor: filter === id ? 'var(--ao-accent, #6366F1)' : 'var(--ao-border)',
                color: filter === id ? 'var(--ao-accent, #6366F1)' : 'var(--ao-text-secondary)',
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

          // Urgência: tempo desde a última msg do cliente sem resposta da equipe.
          // Backend popula `waiting_since` — null = não está aguardando.
          // 0–14min: normal | 15–59min: atenção (amarelo) | 60min+: urgente (vermelho)
          let urgency = null
          if (c.waiting_since) {
            const minsWaiting = (Date.now() - new Date(c.waiting_since).getTime()) / 60000
            if (minsWaiting >= 60) urgency = 'urgente'
            else if (minsWaiting >= 15) urgency = 'atencao'
            else urgency = 'normal'
          }
          // Cores
          const URGENCY_BG = {
            urgente: active ? 'rgba(239, 68, 68, 0.16)' : 'rgba(239, 68, 68, 0.08)',
            atencao: active ? 'rgba(245, 158, 11, 0.14)' : 'rgba(245, 158, 11, 0.06)',
            normal:  active ? 'rgba(16, 185, 129, 0.12)' : 'rgba(16, 185, 129, 0.04)',
          }
          const URGENCY_BORDER = {
            urgente: '#ef4444',
            atencao: '#F59E0B',
            normal:  '#10B981',
          }
          const bg = urgency ? URGENCY_BG[urgency] : (active ? 'var(--ao-surface)' : 'transparent')
          const leftBorderColor = active
            ? 'var(--ao-accent, #6366F1)'
            : (urgency ? URGENCY_BORDER[urgency] : 'transparent')

          return (
            <button
              key={c.id}
              onClick={() => onSelect?.(c)}
              title={urgency === 'urgente' ? `Cliente aguardando há mais de 1h sem resposta` : urgency === 'atencao' ? 'Cliente aguardando há 15min+' : urgency === 'normal' ? 'Cliente respondeu recentemente' : ''}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = urgency ? URGENCY_BG[urgency].replace(/0\.0[0-9]+/, '0.10').replace(/0\.1[0-9]/, '0.14') : 'rgba(255,255,255,0.04)' }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = bg }}
              style={{
                width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: '13px 14px', borderBottom: '1px solid var(--ao-border)',
                background: bg,
                borderLeft: `3px solid ${leftBorderColor}`,
                display: 'flex', gap: 11, alignItems: 'flex-start',
                color: 'var(--ao-text-primary)',
                border: 'none', borderBottom: '1px solid var(--ao-border)',
                transition: 'background 0.12s ease',
              }}
            >
              <div style={(() => {
                const [a, b] = c.is_group ? ['#3B82F6', '#1D4ED8'] : colorFromName(c.client_name || c.phone)
                return {
                  width: 38, height: 38, borderRadius: c.is_group ? 10 : '50%',
                  background: `linear-gradient(135deg, ${a}, ${b})`,
                  color: '#fff', fontSize: 12.5, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                  boxShadow: isWaiting && !c.is_group ? '0 0 0 2px rgba(239,68,68,0.5)' : 'none',
                }
              })()}>
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
                  fontSize: 13.5, fontWeight: 600, marginBottom: 3,
                }}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {name}
                  </span>
                  {time && <span style={{ fontSize: 10, opacity: 0.5, fontWeight: 400 }}>{time}</span>}
                </div>
                {/* Vinculo satelite: indica que esse contato é tomador/sócio/etc de um cliente Átrio */}
                {c.linked_relacao && c.linked_client_name && (
                  <div title={`${(c.linked_relacao || '').toUpperCase()} de ${c.linked_client_name}${c.linked_contato_funcao ? ' · ' + c.linked_contato_funcao : ''}`}
                    style={{
                      fontSize: 10, fontWeight: 600,
                      color: 'rgba(99, 102, 241, 0.85)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      display: 'flex', alignItems: 'center', gap: 3,
                      marginBottom: 2,
                    }}>
                    <span style={{ opacity: 0.7 }}>↪</span>
                    <span style={{
                      fontSize: 8, fontWeight: 600, padding: '0 5px', borderRadius: 3,
                      background: 'rgba(99, 102, 241, 0.10)', color: 'rgba(99, 102, 241, 0.85)',
                      textTransform: 'uppercase', letterSpacing: '0.2px',
                    }}>
                      {c.linked_relacao}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.linked_client_name.split(' ').slice(0, 4).join(' ')}
                    </span>
                  </div>
                )}
                {preview && (
                  <div style={{
                    fontSize: 11, color: 'var(--ao-text-dim)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                    {c.last_message_sender && (
                      <span title={c.last_message_sender === 'client' ? 'Última mensagem foi do cliente' : 'Última mensagem foi da equipe/Luna'}
                        style={{
                          fontSize: 9, lineHeight: 1, flexShrink: 0,
                          color: c.last_message_sender === 'client' ? '#fbbf24' : 'rgba(255,255,255,0.35)',
                        }}>
                        {c.last_message_sender === 'client' ? '↙' : '↗'}
                      </span>
                    )}
                    <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {preview}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
                  {c.is_group && (
                    <span style={{
                      fontSize: 9, padding: '1px 6px', borderRadius: 3,
                      background: 'rgba(59, 130, 246, 0.08)', color: '#60A5FA', fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.2px',
                    }}>
                      grupo
                    </span>
                  )}
                  {isWaiting && !c.is_group && (
                    <span style={{
                      fontSize: 9, padding: '1px 6px', borderRadius: 3,
                      background: 'rgba(239, 68, 68, 0.08)', color: '#fca5a5', fontWeight: 600,
                    }}>
                      aguardando
                    </span>
                  )}
                  {c.resolved && (
                    <span title="Resolvida"
                      style={{
                        fontSize: 11, lineHeight: 1, color: '#10B981', fontWeight: 700,
                        display: 'inline-flex', alignItems: 'center', gap: 2,
                        opacity: 0.85,
                      }}>
                      ✓
                    </span>
                  )}
                  {/* Tag snooze visivel quando filtro 'snoozed' ou hovering */}
                  {c.snoozed_until && new Date(c.snoozed_until) > new Date() && (() => {
                    const ms = new Date(c.snoozed_until).getTime() - Date.now()
                    const h = Math.round(ms / 3600000)
                    const d = Math.round(ms / 86400000)
                    const label = h < 1 ? '<1h' : h < 24 ? `${h}h` : `${d}d`
                    const fullDate = new Date(c.snoozed_until).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                    return (
                      <span title={`Volta em ${fullDate}${c.snoozed_reason ? ' · ' + c.snoozed_reason : ''}`}
                        style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 3,
                          background: 'rgba(127, 119, 221, 0.08)', color: '#A5A1E8', fontWeight: 600,
                          display: 'inline-flex', alignItems: 'center', gap: 2,
                        }}>
                        💤 {label}
                      </span>
                    )
                  })()}
                  {(() => {
                    if (c.resolved || (c.escalation_level || 0) < 2) return null
                    const lastFromClient = c.last_message_sender === 'client'
                    const closurePositive = lastFromClient && isPositiveClosure(c.last_message)
                    if (closurePositive) {
                      const isResolving = resolvingId === c.id
                      return (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => handleInlineResolve(e, c)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleInlineResolve(e, c) }}
                          title={isResolving ? 'Marcando como resolvida...' : 'Cliente agradeceu — clique para marcar como resolvida'}
                          style={{
                            fontSize: 9, padding: '1px 5px', borderRadius: 4,
                            background: 'rgba(16, 185, 129, 0.10)', color: '#10B981', fontWeight: 700,
                            cursor: isResolving ? 'wait' : 'pointer',
                            opacity: isResolving ? 0.5 : 1,
                            transition: 'background .15s, transform .1s',
                            userSelect: 'none',
                          }}
                          onMouseEnter={(e) => { if (!isResolving) e.currentTarget.style.background = 'rgba(16, 185, 129, 0.28)' }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(16, 185, 129, 0.10)' }}
                        >
                          {isResolving ? '...' : '✓ encerrar'}
                        </span>
                      )
                    }
                    return (
                      <span style={{
                        fontSize: 9, padding: '1px 6px', borderRadius: 3,
                        background: 'rgba(245, 158, 11, 0.08)', color: '#FBBF24', fontWeight: 600,
                      }}>
                        crítica
                      </span>
                    )
                  })()}
                  {c.contact_type && (() => {
                    const meta = {
                      equipe:          { label: 'equipe',     bg: 'rgba(6, 182, 212, 0.10)',  fg: '#06B6D4' },
                      parceiro:        { label: 'parceiro',   bg: 'rgba(139, 92, 246, 0.10)', fg: '#8B5CF6' },
                      fornecedor:      { label: 'fornecedor', bg: 'rgba(245, 158, 11, 0.10)', fg: '#F59E0B' },
                      prospect:        { label: 'prospect',   bg: 'rgba(16, 185, 129, 0.10)', fg: '#10B981' },
                      pessoal:         { label: 'pessoal',    bg: 'rgba(100, 116, 139, 0.18)', fg: '#94A3B8' },
                      cliente_externo: { label: 'externo',    bg: 'rgba(59, 130, 246, 0.10)', fg: '#3B82F6' },
                      spam:            { label: 'spam',       bg: 'rgba(239, 68, 68, 0.10)', fg: '#EF4444' },
                    }[c.contact_type]
                    if (!meta) return null
                    return (
                      <span style={{
                        fontSize: 9, padding: '1px 6px', borderRadius: 3,
                        background: meta.bg, color: meta.fg, fontWeight: 600,
                        textTransform: 'uppercase', letterSpacing: '0.2px',
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
