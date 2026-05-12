import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { Send, Loader2, Check, ArrowLeft, Phone, Sparkles, FileText, Calendar, X, Edit2, Paperclip, Users, ExternalLink, Clock} from 'lucide-react'
import MessageBubble from './MessageBubble'
import EnsinarLunaModal from './EnsinarLunaModal'
import TemplatePicker from './TemplatePicker'
import { fetchMessages, sendWhatsApp, markReplied, markResolved, formatPhone, detectCommitment, createCalendarEvent, sendAttachment, snoozeConversation, unsnoozeConversation} from './atendimento-api'

/**
 * Pane de chat de uma conversa — header (cliente) + lista de msgs + input.
 *
 * Props:
 *  - conversation: {id, phone, real_phone, client_name, display_phone, resolved, ...}
 *  - onBack: fn (chamada no botao voltar no layout mobile)
 *  - lastWsMessage: ultimo evento WebSocket (p/ refresh em tempo real)
 *  - onRefreshList: fn chamada apos enviar/resolver (pra atualizar sidebar)
 */
export default function ChatPane({ conversation: conv, onBack, lastWsMessage, onRefreshList, extraHeaderButton }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState(null)
  const [teachOpen, setTeachOpen] = useState(false)
  // Optimistic UI ate o ConversaList re-fetch trazer estado novo
  const [localResolved, setLocalResolved] = useState(false)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [snoozing, setSnoozing] = useState(false)

  const handleSnooze = async (preset) => {
    if (snoozing) return
    setSnoozing(true)
    try {
      await snoozeConversation(conv.id, preset)
      setSnoozeOpen(false)
      onRefreshList?.()
    } catch (e) { alert('Erro: ' + e.message) }
    finally { setSnoozing(false) }
  }
  const handleUnsnooze = async () => {
    if (snoozing) return
    setSnoozing(true)
    try {
      await unsnoozeConversation(conv.id)
      onRefreshList?.()
    } catch (e) { alert('Erro: ' + e.message) }
    finally { setSnoozing(false) }
  }
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [commitments, setCommitments] = useState([])  // sugestoes de compromisso apos envio
  const [savingCommit, setSavingCommit] = useState(null)  // indice sendo salvo
  const [editingCommit, setEditingCommit] = useState(null)  // {idx, date, title}
  const [uploadingFile, setUploadingFile] = useState(false)
  const scrollRef = useRef(null)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const lastConvIdRef = useRef(null)
  const lastMsgIdRef = useRef(null)
  const userScrolledUpRef = useRef(false)

  // Detecta se usuario subiu o scroll de proposito (>150px do fim).
  // Quando estava no fim e chega msg nova: scrolla. Quando subiu: nao interfere.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    userScrolledUpRef.current = distFromBottom > 150
  }, [])

  // Garante que ao trocar de conversa, a lista vai pro FIM (msgs mais recentes).
  // O setTimeout(..., 0) no load() nao bastava: as vezes disparava antes do
  // React renderizar a lista, ai scrollHeight era pequeno e a posicao final
  // ficava no inicio. useLayoutEffect roda apos o DOM atualizar, antes do paint.
  // Restricao: so scrolla quando o id da conversa muda — nao interfere quando
  // chegam novas msgs por WebSocket (esses casos tem proprios scrollTo).
  useLayoutEffect(() => {
    if (!conv?.id || !scrollRef.current || loading) return
    const el = scrollRef.current
    const lastMsg = messages[messages.length - 1]?.id || null
    const convChanged = lastConvIdRef.current !== conv.id
    const msgAppended = lastMsg !== null && lastMsgIdRef.current !== lastMsg

    lastConvIdRef.current = conv.id
    lastMsgIdRef.current = lastMsg

    const goToBottom = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }

    if (convChanged) {
      // Trocou de conversa: SEMPRE no fim, com multiplas tentativas
      // (anexos/imagens carregam async e mudam scrollHeight)
      userScrolledUpRef.current = false
      goToBottom()
      requestAnimationFrame(() => {
        goToBottom()
        requestAnimationFrame(goToBottom)
      })
      // Re-tentativas pra casos de imagens grandes / PDFs carregando preview
      setTimeout(goToBottom, 200)
      setTimeout(goToBottom, 500)
      return
    }

    if (msgAppended && !userScrolledUpRef.current) {
      // Mesma conversa + msg nova + usuario estava no fim: acompanha
      goToBottom()
      requestAnimationFrame(goToBottom)
    }
  }, [conv?.id, loading, messages.length])

  const handleFilePick = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''  // reset pra permitir mesmo arquivo de novo
    if (!file || !phoneToSend) return
    if (file.size > 20 * 1024 * 1024) {
      setError('Arquivo muito grande (max 20MB)')
      return
    }
    setUploadingFile(true); setError(null)
    try {
      await sendAttachment(phoneToSend, file, input.trim())
      setInput('')
      setTimeout(load, 1200)
      onRefreshList?.()
    } catch (e) {
      setError(e.message)
    } finally { setUploadingFile(false) }
  }

  const load = async () => {
    if (!conv?.id) return
    setLoading(true); setError(null)
    try {
      const rows = await fetchMessages(conv.id)
      setMessages(rows)
      // scroll pro fim apos render
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'instant' }), 0)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [conv?.id])
  useEffect(() => { setLocalResolved(false) }, [conv?.id])

  // Refresh quando chega evento WebSocket relevante pra esta conversa
  useEffect(() => {
    if (!lastWsMessage || !conv) return
    const m = lastWsMessage
    const relevant = (
      (m.type === 'whatsapp_message' || m.type === 'conversation_updated') &&
      (m.phone === conv.phone || m.phone === conv.real_phone || m.conversationId === conv.id)
    )
    // Sincronizacao Office <-> iframe Gesthub: outra aba enviou pro Finance,
    // recarrega msgs pra MessageBubble pegar metadata.finance_pending_id atualizada
    const financeSync = m.type === 'extrato_sent_to_finance' && m.conversation_id === conv.id
    if (relevant || financeSync) load()
  }, [lastWsMessage])

  // Usa chat_id primeiro (tem sufixo @c.us ou @g.us canonico pro WhatsApp).
  // Sem chat_id, fallback pro phone (backend decide suffix).
  const phoneToSend = conv?.chat_id || conv?.phone || conv?.real_phone
  const canSend = !!phoneToSend && input.trim().length > 0 && !sending

  const handleSend = async () => {
    if (!canSend) return
    const body = input.trim()
    setSending(true); setError(null)
    // Optimistic: adiciona bubble local enquanto envia
    const tempMsg = { sender: 'team', body, created_at: new Date().toISOString(), _pending: true }
    setMessages(m => [...m, tempMsg])
    setInput('')
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 0)
    try {
      await sendWhatsApp(phoneToSend, body)
      // Fire-and-forget marca como respondida
      markReplied(phoneToSend).catch(() => {})
      // Re-fetch pra pegar a msg oficial persistida
      setTimeout(load, 800)
      onRefreshList?.()
      // Fire-and-forget: detecta se msg contem compromisso com data
      // Se detectado, mostra card flutuante pro user adicionar ao calendario
      detectCommitment(body, conv?.id).then(r => {
        if (Array.isArray(r?.commitments) && r.commitments.length > 0) {
          setCommitments(r.commitments)
        }
      }).catch(() => {})
    } catch (e) {
      setError(e.message)
      // Remove a optimistica em erro
      setMessages(m => m.filter(x => x !== tempMsg))
      setInput(body) // devolve o texto pro input
    } finally { setSending(false) }
  }

  const saveCommitment = async (idx, overrides = {}) => {
    const c = commitments[idx]
    if (!c) return
    setSavingCommit(idx)
    try {
      const date = overrides.date || c.date_iso
      const title = overrides.title || c.title
      // Cria evento all-day na data
      const startTime = new Date(`${date}T09:00:00`).toISOString()
      const endTime = new Date(`${date}T10:00:00`).toISOString()
      await createCalendarEvent({
        title,
        description: `Compromisso assumido no WhatsApp com ${conv?.client_name || 'cliente'}. Frase: "${c.phrase || c.title}"`,
        startTime,
        endTime,
        category: 'compromisso_atendimento',
        metadata: {
          source: 'whatsapp_commitment',
          conversation_id: conv?.id,
          client_name: conv?.client_name,
          phrase_original: c.phrase,
        },
      })
      // Remove esse commitment da lista (mantem outros)
      setCommitments(prev => prev.filter((_, i) => i !== idx))
    } catch (e) {
      alert('Erro ao agendar: ' + e.message)
    } finally { setSavingCommit(null); setEditingCommit(null) }
  }

  const dismissCommitment = (idx) => {
    setCommitments(prev => prev.filter((_, i) => i !== idx))
    if (editingCommit?.idx === idx) setEditingCommit(null)
  }

  const handleResolve = async () => {
    if (!phoneToSend) return
    setResolving(true); setError(null)
    try {
      await markResolved(phoneToSend)
      setLocalResolved(true)
      onRefreshList?.()
    } catch (e) { setError(e.message) }
    finally { setResolving(false) }
  }
  const isResolved = conv?.resolved || localResolved

  if (!conv) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--ao-text-dim)' }}>
        <div style={{ textAlign: 'center', opacity: 0.6 }}>
          <Phone size={32} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div style={{ fontSize: 13 }}>Selecione uma conversa pra abrir o chat</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full" style={{ background: 'var(--ao-bg)', minWidth: 0 }}>
      {/* Header da conversa */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', borderBottom: '1px solid var(--ao-border)',
        background: 'var(--ao-card)',
      }}>
        {onBack && (
          <button
            onClick={onBack}
            className="chat-header-btn"
            style={{
              background: 'transparent', border: 'none', color: 'var(--ao-text-primary)', cursor: 'pointer',
              width: 40, height: 40, borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, padding: 0,
            }}
            aria-label="Voltar"
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <div style={{
          width: 34, height: 34, borderRadius: '50%',
          background: conv.is_group
            ? 'linear-gradient(135deg, #6366F1, #4F46E5)'
            : 'linear-gradient(135deg, #10B981, #059669)',
          color: '#fff', fontWeight: 700, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {conv.is_group ? <Users size={16} /> : (conv.client_name || '?').slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ao-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{conv.client_name || 'Sem nome'}</span>
            {/* Badge satelite: indica que conversa esta vinculada como tomador/socio/etc de um cliente Atrio */}
            {conv.linked_relacao && conv.linked_client_name && (
              <span title={`Esta conversa está vinculada como ${conv.linked_relacao.toUpperCase()} de ${conv.linked_client_name}${conv.linked_contato_funcao ? ' · ' + conv.linked_contato_funcao : ''}`}
                style={{
                  fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4,
                  background: 'rgba(99, 102, 241, 0.16)',
                  color: 'rgba(99, 102, 241, 0.95)',
                  border: '1px solid rgba(99, 102, 241, 0.28)',
                  textTransform: 'uppercase', letterSpacing: '0.4px',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                {conv.linked_relacao} · {conv.linked_client_name.split(' ').slice(0, 3).join(' ')}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {conv.is_group ? (
              <>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  padding: '1px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                  background: 'rgba(99,102,241,0.15)', color: '#6366F1', textTransform: 'uppercase',
                }}>
                  <Users size={9} /> Grupo
                </span>
                {(conv.participants_count > 0) && <span>{conv.participants_count} participantes</span>}
              </>
            ) : (
              <>
                <span>{conv.display_phone || formatPhone(conv.real_phone || conv.phone)}</span>
                {conv.last_client_at && (() => {
                  const lastMs = new Date(conv.last_client_at).getTime();
                  const ageMin = (Date.now() - lastMs) / 60000;
                  // 'Online' presumido apenas se cliente mandou nos ultimos 5min
                  const isOnline = ageMin < 5;
                  let label = '';
                  if (isOnline) label = 'ativo agora';
                  else if (ageMin < 60) label = `cliente ativo há ${Math.round(ageMin)}min`;
                  else if (ageMin < 24 * 60) {
                    const lastDate = new Date(conv.last_client_at);
                    label = `última msg do cliente às ${lastDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
                  } else if (ageMin < 7 * 24 * 60) {
                    label = `cliente sem msg há ${Math.round(ageMin / 60 / 24)}d`;
                  } else {
                    const lastDate = new Date(conv.last_client_at);
                    label = `última em ${lastDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
                  }
                  return (
                    <span title={new Date(conv.last_client_at).toLocaleString('pt-BR')}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
                      <span aria-hidden style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: isOnline ? '#10B981' : ageMin < 60 ? '#F59E0B' : 'rgba(255,255,255,0.25)',
                        boxShadow: isOnline ? '0 0 6px rgba(16,185,129,0.6)' : 'none',
                        flexShrink: 0,
                      }} />
                      <span style={{ fontSize: 10.5 }}>· {label}</span>
                    </span>
                  );
                })()}
              </>
            )}
            {conv.resolved && <span style={{ marginLeft: 4, color: '#10B981' }}>· resolvida</span>}
          </div>
        </div>
        {extraHeaderButton}
        {(conv.linked_client_id || conv.gesthub_client_id) && (
          <a
            href={`http://31.97.175.200/?client=${conv.linked_client_id || conv.gesthub_client_id}&tab=cliente360`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Abrir Cliente 360 — ${conv.linked_client_name || 'cliente vinculado'}`}
            className="chat-header-btn-action"
            style={{
              padding: '7px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8,
              border: '1px solid var(--ao-border)',
              background: 'transparent', color: 'var(--ao-text-secondary)',
              cursor: 'pointer', textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              minHeight: 36, minWidth: 36, justifyContent: 'center',
            }}
          >
            <ExternalLink size={13} />
            <span className="chat-btn-label">Cliente 360</span>
          </a>
        )}
        <button
          onClick={() => setTeachOpen(true)}
          title="Ensinar Luna a partir desta conversa"
          className="chat-header-btn-action chat-btn-teach"
          style={{
            padding: '7px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8,
            border: '1px solid rgba(99, 102, 241, 0.4)',
            background: 'rgba(99, 102, 241, 0.1)', color: '#6366F1',
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            minHeight: 36, minWidth: 36, justifyContent: 'center',
          }}
        >
          <Sparkles size={13} />
          <span className="chat-btn-label">Ensinar Luna</span>
        </button>
        {/* Snooze button + dropdown */}
        {!isResolved && (() => {
          const isSnoozed = conv.snoozed_until && new Date(conv.snoozed_until) > new Date()
          if (isSnoozed) {
            const dt = new Date(conv.snoozed_until)
            const ms = dt.getTime() - Date.now()
            const h = Math.round(ms / 3600000)
            const d = Math.round(ms / 86400000)
            const label = h < 1 ? '<1h' : h < 24 ? `${h}h` : `${d}d`
            return (
              <button
                onClick={handleUnsnooze}
                disabled={snoozing}
                title={`Snoozed até ${dt.toLocaleString('pt-BR')}. Clique para cancelar.`}
                className="chat-header-btn-action"
                style={{
                  padding: '7px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8,
                  border: '1px solid rgba(127, 119, 221, 0.4)',
                  background: 'rgba(127, 119, 221, 0.1)', color: '#7F77DD',
                  cursor: snoozing ? 'wait' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  minHeight: 36, minWidth: 36, justifyContent: 'center',
                }}
              >
                💤 <span className="chat-btn-label">{label}</span>
              </button>
            )
          }
          return (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setSnoozeOpen(v => !v)}
                disabled={snoozing}
                title="Adiar conversa (volta automaticamente)"
                className="chat-header-btn-action"
                style={{
                  padding: '7px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8,
                  border: '1px solid var(--ao-border)',
                  background: snoozeOpen ? 'rgba(127, 119, 221, 0.12)' : 'transparent',
                  color: 'var(--ao-text-secondary)',
                  cursor: snoozing ? 'wait' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  minHeight: 36, minWidth: 36, justifyContent: 'center',
                }}
              >
                <Clock size={13} />
                <span className="chat-btn-label">Snooze</span>
              </button>
              {snoozeOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  background: 'var(--ao-card)', border: '1px solid var(--ao-border)',
                  borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                  zIndex: 100, minWidth: 180, padding: 4,
                }}>
                  {[
                    ['1h', 'Em 1 hora'],
                    ['4h', 'Em 4 horas'],
                    ['tomorrow', 'Amanhã 9h'],
                    ['friday', 'Sexta 9h'],
                    ['7d', 'Em 7 dias'],
                  ].map(([preset, label]) => (
                    <button
                      key={preset}
                      onClick={() => handleSnooze(preset)}
                      disabled={snoozing}
                      style={{
                        width: '100%', textAlign: 'left', padding: '8px 12px',
                        fontSize: 12, border: 'none', background: 'transparent',
                        color: 'var(--ao-text-primary)', cursor: 'pointer',
                        borderRadius: 5, display: 'block',
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(127, 119, 221, 0.1)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
        {!isResolved && (
          <button
            onClick={handleResolve}
            disabled={resolving}
            title="Marcar como resolvida"
            className="chat-header-btn-action chat-btn-resolve"
            style={{
              padding: '7px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8,
              border: '1px solid rgba(16, 185, 129, 0.4)',
              background: 'rgba(16, 185, 129, 0.1)', color: '#10B981',
              cursor: resolving ? 'wait' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 5,
              minHeight: 36, minWidth: 36, justifyContent: 'center',
            }}
          >
            {resolving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            <span className="chat-btn-label">Resolver</span>
          </button>
        )}
      </div>

      <EnsinarLunaModal
        open={teachOpen}
        onClose={() => setTeachOpen(false)}
        conversation={conv}
        seedContent={(() => {
          // Pre-preenche com as ultimas 2-3 mensagens pra dar contexto
          const last = messages.slice(-3).map(m => {
            const who = (m.sender || m.direction || '').toLowerCase() === 'client' || (m.sender || m.direction || '').toLowerCase() === 'inbound' ? 'Cliente' : (m.sender === 'luna' || m.sender === 'bot' ? 'Luna' : 'Equipe')
            return `[${who}] ${(m.body || m.content || '').slice(0, 200)}`
          }).join('\n')
          return last ? `Contexto da conversa:\n${last}\n\nComo Luna deve agir em casos similares:\n` : ''
        })()}
      />

      {/* Lista de mensagens */}
      <div ref={scrollRef} onScroll={handleScroll}
        style={{
          flex: 1, overflowY: 'auto', padding: '12px 14px',
          background: 'var(--ao-bg)',
        }}
      >
        {loading && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: 20, opacity: 0.5 }}>
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: 30, opacity: 0.4, fontSize: 12 }}>
            Nenhuma mensagem nesta conversa ainda.
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble
            key={m.id || i}
            msg={{ ...m, conversationGesthubClientId: conv?.gesthub_client_id || conv?.linked_client_id || null }}
            onDeleted={(deletedId) => {
              // Otimistic: marca como apagada na UI imediatamente; re-fetch confirma
              setMessages(prev => prev.map(x =>
                x.id === deletedId
                  ? { ...x, body: '[mensagem apagada]', metadata: { ...(x.metadata || {}), deleted: true, deleted_at: new Date().toISOString() } }
                  : x
              ))
              setTimeout(load, 400)
            }}
          />
        ))}
      </div>

      {error && (
        <div style={{
          padding: '6px 14px', fontSize: 11, color: '#ef4444',
          background: 'rgba(239, 68, 68, 0.08)', borderTop: '1px solid rgba(239, 68, 68, 0.2)',
        }}>
          {error}
        </div>
      )}

      {/* Commitment cards — sugestoes de compromisso detectado pela Luna apos envio */}
      {commitments.length > 0 && (
        <div style={{
          padding: '8px 12px', borderTop: '1px solid var(--ao-border)',
          background: 'rgba(99, 102, 241, 0.06)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {commitments.map((c, idx) => {
            const dateStr = (() => {
              const d = new Date(c.date_iso + 'T12:00:00')
              return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })
            })()
            const isEditing = editingCommit?.idx === idx
            const isSaving = savingCommit === idx
            return (
              <div key={idx} style={{
                padding: '8px 10px', borderRadius: 10,
                background: 'var(--ao-card)',
                border: '1px solid rgba(99, 102, 241, 0.35)',
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: 'rgba(99, 102, 241, 0.18)', color: '#6366F1',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Calendar size={14} />
                </div>
                {isEditing ? (
                  <>
                    <input
                      type="date"
                      value={editingCommit.date}
                      onChange={e => setEditingCommit({ ...editingCommit, date: e.target.value })}
                      style={{
                        padding: '4px 8px', fontSize: 12, borderRadius: 6,
                        border: '1px solid var(--ao-border)',
                        background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
                      }}
                    />
                    <input
                      type="text"
                      value={editingCommit.title}
                      onChange={e => setEditingCommit({ ...editingCommit, title: e.target.value })}
                      style={{
                        flex: 1, minWidth: 120,
                        padding: '4px 8px', fontSize: 12, borderRadius: 6,
                        border: '1px solid var(--ao-border)',
                        background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
                      }}
                    />
                  </>
                ) : (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ao-text-primary)' }}>
                      {c.title}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)', textTransform: 'capitalize' }}>
                      {dateStr}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {isEditing ? (
                    <>
                      <button
                        onClick={() => saveCommitment(idx, { date: editingCommit.date, title: editingCommit.title })}
                        disabled={isSaving}
                        style={{
                          padding: '5px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6,
                          border: 'none', background: '#10B981', color: '#fff',
                          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        {isSaving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                        Salvar
                      </button>
                      <button
                        onClick={() => setEditingCommit(null)}
                        style={{
                          padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6,
                          border: '1px solid var(--ao-border)', background: 'transparent',
                          color: 'var(--ao-text-secondary)', cursor: 'pointer',
                        }}
                      >
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => saveCommitment(idx)}
                        disabled={isSaving}
                        title="Adicionar ao calendário"
                        style={{
                          padding: '5px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6,
                          border: 'none', background: 'linear-gradient(135deg, #6366F1, #A67B52)',
                          color: '#fff', cursor: isSaving ? 'wait' : 'pointer',
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        {isSaving ? <Loader2 size={11} className="animate-spin" /> : <Calendar size={11} />}
                        Agendar
                      </button>
                      <button
                        onClick={() => setEditingCommit({ idx, date: c.date_iso, title: c.title })}
                        title="Editar antes de salvar"
                        style={{
                          width: 26, height: 26, borderRadius: 6,
                          border: '1px solid var(--ao-border)', background: 'transparent',
                          color: 'var(--ao-text-dim)', cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Edit2 size={11} />
                      </button>
                      <button
                        onClick={() => dismissCommitment(idx)}
                        title="Ignorar"
                        style={{
                          width: 26, height: 26, borderRadius: 6,
                          border: '1px solid var(--ao-border)', background: 'transparent',
                          color: 'var(--ao-text-dim)', cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <X size={11} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Input */}
      <div className="chat-input-bar" style={{
        padding: '10px 12px', borderTop: '1px solid var(--ao-border)',
        background: 'var(--ao-card)', display: 'flex', gap: 8, alignItems: 'flex-end',
      }}>
        <button
          onClick={() => setTemplatesOpen(true)}
          title="Inserir template (Ctrl+T)"
          className="chat-input-btn"
          style={{
            width: 40, height: 40, borderRadius: 10,
            border: '1px solid var(--ao-border)', background: 'var(--ao-bg)',
            color: 'var(--ao-text-secondary)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, padding: 0,
          }}
          aria-label="Templates"
        >
          <FileText size={16} />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingFile || !phoneToSend}
          title="Anexar arquivo (PDF, imagem)"
          className="chat-input-btn"
          style={{
            width: 40, height: 40, borderRadius: 10,
            border: '1px solid var(--ao-border)', background: 'var(--ao-bg)',
            color: uploadingFile ? 'var(--ao-accent, #6366F1)' : 'var(--ao-text-secondary)',
            cursor: uploadingFile ? 'wait' : 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, padding: 0,
          }}
          aria-label="Anexar arquivo"
        >
          {uploadingFile ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={handleFilePick}
          accept="application/pdf,image/*,audio/*,.docx,.xlsx,.xls,.doc"
        />
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            } else if (e.key === 't' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              setTemplatesOpen(true)
            }
          }}
          placeholder="Digite sua mensagem..."
          rows={1}
          className="chat-textarea"
          style={{
            flex: 1, resize: 'none', minHeight: 40, maxHeight: 120,
            padding: '10px 12px', fontSize: 14, borderRadius: 10,
            border: '1px solid var(--ao-border)',
            background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
            fontFamily: 'inherit', lineHeight: 1.4,
          }}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="chat-send-btn"
          style={{
            width: 40, height: 40, borderRadius: 10, border: 'none',
            background: canSend ? 'linear-gradient(135deg, #10B981, #059669)' : 'var(--ao-surface)',
            color: canSend ? '#fff' : 'var(--ao-text-dim)',
            cursor: canSend ? 'pointer' : 'not-allowed',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, padding: 0,
            boxShadow: canSend ? '0 2px 8px rgba(16,185,129,0.35)' : 'none',
            transition: 'transform 0.1s, box-shadow 0.15s',
          }}
          aria-label="Enviar"
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>

      <TemplatePicker
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onPick={(text) => {
          // Insere template no input. Se ja tiver texto, concatena com quebra dupla.
          setInput(prev => prev.trim() ? `${prev.trim()}\n\n${text}` : text)
          // Foca o textarea pra usuario preencher placeholders restantes (ex: {valor})
          setTimeout(() => {
            const ta = textareaRef.current
            if (ta) {
              ta.focus()
              // Posiciona cursor no primeiro placeholder livre, se houver
              const match = ta.value.match(/\{[^}]+\}/)
              if (match) {
                ta.setSelectionRange(match.index, match.index + match[0].length)
              }
            }
          }, 80)
        }}
        conversation={conv}
        currentInput={input}
      />
    </div>
  )
}
