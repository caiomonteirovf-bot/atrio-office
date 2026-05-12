import { useState, useEffect, useRef } from 'react'
import { X, Send, Loader2, User, Bot, AtSign, CheckCircle2, Clock, AlertTriangle } from 'lucide-react'

const AGENT_COLORS = {
  Rodrigo: '#8b5cf6',
  Campelo: '#378ADD',
  Sneijder: '#10b981',
  Luna: '#f59e0b',
  Saldanha: '#ec4899',
  'André': '#06b6d4',
  Auditor: '#ef4444',
}

const AGENT_NAMES = ['Rodrigo', 'Campelo', 'Sneijder', 'Luna', 'Saldanha', 'André', 'Auditor']

export default function TaskDetailModal({ taskId, onClose, ws }) {
  const [task, setTask] = useState(null)
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const endRef = useRef(null)

  const load = async () => {
    try {
      const [taskRes, commentsRes] = await Promise.all([
        fetch(`/api/tasks/${taskId}`).then(r => r.ok ? r.json() : null),
        fetch(`/api/tasks/${taskId}/comments`).then(r => r.json()),
      ])
      if (taskRes) setTask(taskRes.data || taskRes)
      setComments(commentsRes.data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { if (taskId) load() }, [taskId])

  // WebSocket listener pra refresh quando outro comment chegar
  useEffect(() => {
    if (!ws) return
    const h = (evt) => {
      try {
        const m = JSON.parse(evt.data)
        if (m.type === 'task_comment' && m.task_id === taskId) load()
      } catch {}
    }
    ws.addEventListener?.('message', h)
    return () => ws.removeEventListener?.('message', h)
  }, [ws, taskId])

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [comments.length])

  const send = async () => {
    if (!input.trim() || sending) return
    setSending(true)
    try {
      const r = await fetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input.trim(), author_name: 'Caio' }),
      })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || 'falha')
      setInput('')
      setMentionOpen(false)
      await load()
    } catch (e) { alert('Erro: ' + e.message) }
    finally { setSending(false) }
  }

  const insertMention = (name) => {
    const cur = input
    const lastAt = cur.lastIndexOf('@')
    const newInput = lastAt >= 0
      ? cur.slice(0, lastAt) + `@${name} `
      : `@${name} ` + cur
    setInput(newInput)
    setMentionOpen(false)
    inputRef.current?.focus()
  }

  const handleInputChange = (e) => {
    const v = e.target.value
    setInput(v)
    // Detecta @ no final pra abrir dropdown
    const lastChar = v.slice(-1)
    if (lastChar === '@') setMentionOpen(true)
    else if (!v.includes('@')) setMentionOpen(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape') onClose()
  }

  if (!taskId) return null

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--ao-bg)', border: '1px solid var(--ao-border)', borderRadius: 10,
        width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--ao-border)',
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
              {task?.status ? <StatusBadge status={task.status} /> : 'Carregando...'}
              {task?.assigned_name && (
                <span style={{ marginLeft: 8, color: AGENT_COLORS[task.assigned_name], fontWeight: 600 }}>
                  {task.assigned_name}
                </span>
              )}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ao-text-primary)', lineHeight: 1.35 }}>
              {task?.title || '...'}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ao-text-dim)',
            padding: 4, display: 'inline-flex',
          }}>
            <X size={16} />
          </button>
        </div>

        {/* Detalhes da task (description, result, ações) */}
        {task && !loading && <TaskDetails task={task} onReload={load} />}

        {/* Messages / Comments */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', background: 'var(--ao-surface)' }}>
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 20, opacity: 0.6 }}>
              <Loader2 className="animate-spin" size={16} />
            </div>
          )}
          {!loading && comments.length === 0 && (
            <div style={{ textAlign: 'center', padding: 30, opacity: 0.6, fontSize: 12 }}>
              Sem comentários ainda. Mencione um agente com @nome para acordá-lo.
            </div>
          )}
          {comments.map(c => <CommentBubble key={c.id} c={c} />)}
          <div ref={endRef} />
        </div>

        {/* Input */}
        <div style={{
          borderTop: '1px solid var(--ao-border)', padding: 10, position: 'relative',
        }}>
          {mentionOpen && (
            <div style={{
              position: 'absolute', bottom: '100%', left: 10, right: 10,
              background: 'var(--ao-bg)', border: '1px solid var(--ao-border)',
              borderRadius: 6, padding: 4, boxShadow: '0 -4px 12px rgba(0,0,0,0.2)',
              maxHeight: 180, overflow: 'auto',
            }}>
              <div style={{ fontSize: 10, opacity: 0.5, padding: '4px 8px', textTransform: 'uppercase' }}>
                Mencionar (dispara wake do agente)
              </div>
              {AGENT_NAMES.map(n => (
                <button key={n} onClick={() => insertMention(n)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', width: '100%',
                  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ao-text-primary)',
                  borderRadius: 4, textAlign: 'left', fontSize: 12,
                }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--ao-surface)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%', background: AGENT_COLORS[n] || '#64748b',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    color: 'white', fontSize: 10, fontWeight: 700,
                  }}>{n.charAt(0)}</span>
                  @{n}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Comentário... use @agente para acionar"
              rows={2}
              style={{
                flex: 1, resize: 'none', padding: '8px 12px', borderRadius: 6,
                background: 'var(--ao-input-bg, #0f0f12)', border: '1px solid var(--ao-border)',
                color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={() => setMentionOpen(v => !v)}
              title="Mencionar agente"
              style={{
                padding: 8, borderRadius: 6, border: '1px solid var(--ao-border)',
                background: mentionOpen ? 'var(--ao-accent-muted, rgba(196,149,106,0.15))' : 'transparent',
                color: 'var(--ao-text-dim)', cursor: 'pointer',
              }}>
              <AtSign size={14} />
            </button>
            <button onClick={send} disabled={!input.trim() || sending} style={{
              padding: '8px 14px', borderRadius: 6, border: 'none',
              background: sending ? '#94a3b8' : 'var(--ao-accent, #6366F1)', color: 'white', cursor: sending ? 'wait' : 'pointer',
              fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4,
              opacity: (!input.trim() || sending) ? 0.5 : 1,
            }}>
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Enviar
            </button>
          </div>
          <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
            Enter envia · Shift+Enter quebra linha · @agente acorda o agente na hora
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskDetails({ task, onReload }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)

  const description = task?.description || ''
  const result = task?.result || {}
  const enrich = result?.enrich || null

  // Mensagem aprovavel (Natalia + outros)
  const msgSugerida = result?.msg_sugerida
  const sentToHistorico = result?.sent_to
  const sentMessage = result?.sent_message
  const [editedMsg, setEditedMsg] = useState(msgSugerida || '')
  const [overrideTelefone, setOverrideTelefone] = useState('')
  const [sending, setSending] = useState(false)
  const [sendStatus, setSendStatus] = useState(null)
  const showApprove = msgSugerida && task?.status !== 'done'

  const handleApproveAndSend = async () => {
    if (!editedMsg.trim()) { setSendStatus({ ok: false, msg: 'Mensagem vazia' }); return }
    if (!confirm(`Enviar agora?\n\n${editedMsg.slice(0, 200)}${editedMsg.length > 200 ? '...' : ''}`)) return
    setSending(true); setSendStatus(null)
    try {
      const r = await fetch(`/api/tasks/${task.id}/approve-and-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: editedMsg, telefone: overrideTelefone || undefined }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.error || 'falha')
      setSendStatus({ ok: true, msg: `Enviado para ${d.sent_to}` })
      setTimeout(() => onReload?.(), 1200)
    } catch (e) { setSendStatus({ ok: false, msg: e.message }) }
    finally { setSending(false) }
  }

  // Extrai lista de itens (linhas começando com "-")
  const items = description.split('\n').map(l => l.trim()).filter(l => l.startsWith('-'))
  const hasCnpjs = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/.test(description)

  // Enriquecer via Receita Federal so faz sentido quando a task fala de
  // dados CADASTRAIS (que a RF de fato retorna). Tasks sobre honorario,
  // fator R, classificacao CS, etc. nao tem nada a ver com RF.
  const _haystack = `${task.title || ''} ${description}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const ENRICHABLE_KEYWORDS = [
    'razao social', 'nome fantasia', 'cnae', 'endereco', 'logradouro', 'bairro', 'cep',
    'socios', 'socio', 'natureza juridica', 'porte', 'capital social', 'data abertura',
    'situacao cadastral', 'dados cadastrais', 'cadastro incompleto', 'dados incompletos',
    'enriquecer', 'enriquecimento', 'cadastro', 'receita federal',
  ]
  // Palavras que indicam "nao e dado de RF" — suprime o botao
  const NON_ENRICHABLE_KEYWORDS = [
    'honorario', 'honorarios', 'monthly_fee', 'mensalidade', 'valor cobrado',
    'fator r', 'classificacao cs', 'analista', 'responsavel', 'celula',
    'prazo', 'entrega', 'competencia', 'tipo ctr',
  ]
  const hasEnrichableKw = ENRICHABLE_KEYWORDS.some(k => _haystack.includes(k))
  const hasNonEnrichableKw = NON_ENRICHABLE_KEYWORDS.some(k => _haystack.includes(k))
  // Mostra botao se: tem CNPJ + (tem palavra cadastral OU ja foi enriquecida antes)
  //                  E nao tem palavra indicando que e de honorario/operacional
  const showEnrichBtn = hasCnpjs && (hasEnrichableKw || !!enrich) && !hasNonEnrichableKw

  const handleEnrich = async () => {
    setEnriching(true); setEnrichMsg(null)
    try {
      const r = await fetch(`/api/tasks/${task.id}/enrich`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error || 'falha')
      setEnrichMsg(d.message || 'Enriquecimento iniciado. Atualize em 1-2min.')
      setTimeout(() => onReload?.(), 90 * 1000)
    } catch (e) { setEnrichMsg('Erro: ' + e.message) }
    finally { setEnriching(false) }
  }

  const handleCsv = () => {
    window.open(`/api/tasks/${task.id}/export-csv`, '_blank')
  }

  return (
    <div style={{
      padding: '12px 18px', borderBottom: '1px solid var(--ao-border)',
      background: 'var(--ao-bg)', fontSize: 12, color: 'var(--ao-text-primary)',
      maxHeight: 320, overflowY: 'auto',
    }}>
      {/* Metadados */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10, fontSize: 11, opacity: 0.75 }}>
        {task.priority && <span><strong>Prioridade:</strong> {task.priority}</span>}
        {task.created_at && <span><strong>Criada:</strong> {new Date(task.created_at).toLocaleString('pt-BR')}</span>}
        {task.completed_at && <span><strong>Concluída:</strong> {new Date(task.completed_at).toLocaleString('pt-BR')}</span>}
      </div>

      {/* Description */}
      {description && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', marginBottom: 4 }}>Detalhes</div>
          <pre style={{
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, padding: 10,
            background: 'var(--ao-surface)', borderRadius: 6, fontSize: 12,
            fontFamily: 'inherit', maxHeight: 180, overflowY: 'auto',
          }}>{description}</pre>
          {items.length > 0 && (
            <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>{items.length} item(ns) listado(s)</div>
          )}
        </div>
      )}

      {/* Mensagem aprovavel (Natalia / outros) */}
      {showApprove && (
        <div style={{
          marginBottom: 10, padding: 10, borderRadius: 8,
          background: 'rgba(139, 92, 246, 0.08)',
          border: '1px solid rgba(139, 92, 246, 0.3)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#8B5CF6', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            ✉️ Mensagem sugerida — revise e envie
          </div>
          <textarea
            value={editedMsg}
            onChange={e => setEditedMsg(e.target.value)}
            style={{
              width: '100%', minHeight: 80, padding: 8, fontSize: 12.5,
              fontFamily: 'inherit', borderRadius: 6,
              border: '1px solid var(--ao-border)',
              background: 'var(--ao-card)', color: 'var(--ao-text-primary)',
              resize: 'vertical', marginBottom: 6,
            }}
            placeholder="Edite a mensagem antes de enviar..."
          />
          <input
            value={overrideTelefone}
            onChange={e => setOverrideTelefone(e.target.value)}
            placeholder="(opcional) telefone — deixe vazio pra usar o do contato Gesthub"
            style={{
              width: '100%', padding: '6px 10px', fontSize: 11.5,
              borderRadius: 6, border: '1px solid var(--ao-border)',
              background: 'var(--ao-card)', color: 'var(--ao-text-primary)', marginBottom: 6,
            }}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={handleApproveAndSend}
              disabled={sending || !editedMsg.trim()}
              style={{
                padding: '7px 14px', fontSize: 11.5, fontWeight: 700, borderRadius: 6,
                background: sending || !editedMsg.trim() ? 'var(--ao-surface)' : '#8B5CF6',
                color: sending || !editedMsg.trim() ? 'var(--ao-text-dim)' : '#fff',
                border: 'none',
                cursor: sending || !editedMsg.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {sending ? 'Enviando...' : 'Aprovar e enviar via WhatsApp'}
            </button>
            {sendStatus && (
              <span style={{
                fontSize: 11,
                color: sendStatus.ok ? '#10B981' : '#EF4444',
                fontWeight: 600,
              }}>
                {sendStatus.ok ? '✓ ' : '✗ '}{sendStatus.msg}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Histórico de envio */}
      {sentToHistorico && (
        <div style={{
          marginBottom: 10, padding: 8, borderRadius: 6,
          background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.3)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>✓ Mensagem enviada para {sentToHistorico}</div>
          {sentMessage && (
            <div style={{ fontSize: 11, opacity: 0.85, fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
              "{sentMessage}"
            </div>
          )}
        </div>
      )}

      {/* Resultado do enriquecimento (se houve) */}
      {enrich && (
        <div style={{ marginBottom: 10, padding: 8, background: 'rgba(16, 185, 129, 0.08)', borderRadius: 6, border: '1px solid rgba(16, 185, 129, 0.3)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>✅ Enriquecimento executado</div>
          <div style={{ fontSize: 11, opacity: 0.85 }}>
            {(enrich.sucesso?.length || 0)} sucessos, {(enrich.falha?.length || 0)} falhas, {(enrich.naoEncontrado?.length || 0)} não encontrados
            {enrich.ranAt && <span style={{ opacity: 0.6 }}> · {new Date(enrich.ranAt).toLocaleString('pt-BR')}</span>}
          </div>
        </div>
      )}

      {/* Resultado genérico (se não for enrich, mas tem algo) */}
      {!enrich && result && Object.keys(result).length > 0 && (
        <details style={{ marginBottom: 10, fontSize: 11 }}>
          <summary style={{ cursor: 'pointer', opacity: 0.7 }}>Resultado (JSON)</summary>
          <pre style={{ marginTop: 6, padding: 8, background: 'var(--ao-surface)', borderRadius: 6, fontSize: 10, maxHeight: 120, overflow: 'auto' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
      )}

      {/* Ações */}
      {hasCnpjs && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
          <button onClick={handleCsv} style={{
            padding: '6px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6,
            border: '1px solid var(--ao-border)', background: 'var(--ao-surface)',
            color: 'var(--ao-text-primary)', cursor: 'pointer',
          }}>📥 Baixar CSV</button>
          {showEnrichBtn && (
            <button onClick={handleEnrich} disabled={enriching} title="Consulta Receita Federal p/ preencher dados cadastrais (razao social, CNAE, endereco, socios, situacao...)" style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6,
              border: 'none', background: 'var(--ao-accent, #6366F1)', color: 'white',
              cursor: enriching ? 'wait' : 'pointer', opacity: enriching ? 0.6 : 1,
            }}>{enriching ? '⏳ Enriquecendo...' : '⚡ Enriquecer via Receita Federal'}</button>
          )}
          {!showEnrichBtn && hasNonEnrichableKw && (
            <span style={{ fontSize: 10, opacity: 0.5, fontStyle: 'italic' }}>
              (Enriquecer via RF indisponivel — task nao envolve dados cadastrais)
            </span>
          )}
          {enrichMsg && <span style={{ fontSize: 11, opacity: 0.8 }}>{enrichMsg}</span>}
        </div>
      )}
    </div>
  )
}

function CommentBubble({ c }) {
  const isAgent = c.author_type === 'agent'
  const color = AGENT_COLORS[c.author_name] || (isAgent ? '#64748b' : '#94a3b8')
  const mentions = Array.isArray(c.mentions) ? c.mentions : []

  return (
    <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
        background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'white', fontSize: 11, fontWeight: 700,
      }}>
        {isAgent ? <Bot size={13} /> : (c.author_name?.charAt(0) || '?').toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
          <strong style={{ fontSize: 12, color }}>{c.author_name}</strong>
          {isAgent && c.resolved_agent_role && (
            <span style={{ fontSize: 10, opacity: 0.5 }}>{c.resolved_agent_role}</span>
          )}
          {mentions.length > 0 && (
            <span style={{ fontSize: 10, opacity: 0.6 }}>
              → @{mentions.join(', @')}
              {c.triggered_wake && <span style={{ color: '#10b981', marginLeft: 4 }}>✓ acordado</span>}
            </span>
          )}
          <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 'auto' }}>{fmtAgo(c.created_at)}</span>
        </div>
        <div style={{
          fontSize: 13, color: 'var(--ao-text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.4,
        }}>
          {c.content}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const map = {
    pending:     { label: 'pendente', color: '#eab308', icon: Clock },
    in_progress: { label: 'em andamento', color: '#3b82f6', icon: Loader2 },
    done:        { label: 'concluída', color: '#10b981', icon: CheckCircle2 },
    blocked:     { label: 'bloqueada', color: '#ef4444', icon: AlertTriangle },
    cancelled:   { label: 'cancelada', color: '#64748b', icon: X },
  }
  const cfg = map[status] || { label: status, color: '#64748b' }
  const Icon = cfg.icon
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px',
      background: `${cfg.color}20`, color: cfg.color, fontWeight: 700, borderRadius: 3,
      fontSize: 10, textTransform: 'uppercase',
    }}>
      {Icon && <Icon size={10} />}
      {cfg.label}
    </span>
  )
}

function fmtAgo(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}min`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
