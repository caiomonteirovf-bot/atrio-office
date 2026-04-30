import { useState, useRef, useEffect } from 'react'
import { Sparkles, Send, Loader2, MessageCircle, Lightbulb } from 'lucide-react'
import { askCopilot } from './atendimento-api'

/**
 * Copilot IA — assistente interno (sem WhatsApp, so pro operador).
 * Injeta contexto automatico: cliente + msgs + RAG + tasks.
 *
 * Props:
 *  - conversation: conversa ativa (id + dados)
 *  - client: dados Gesthub do cliente ligado (ou null)
 */
export default function CopilotPane({ conversation: conv, client }) {
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState([]) // [{q, a, model, latency, ctx}]
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const scrollRef = useRef(null)

  // Prompts sugeridos (click = envia direto)
  const suggestedPrompts = [
    'Este cliente tem pendências fiscais abertas?',
    'Qual o fator R deste cliente?',
    'O que o cliente perguntou e ainda não foi respondido?',
    'Resume as últimas mensagens desta conversa',
    'Quais memórias do RAG se aplicam a este caso?',
  ]

  const handleAsk = async (override) => {
    const q = (override ?? question).trim()
    if (!q || loading || !conv?.id) return
    setLoading(true); setError(null)
    // Otimistic: mostra pergunta imediato
    const entry = { q, a: null, loading: true, at: new Date().toISOString() }
    setHistory(h => [...h, entry])
    setQuestion('')
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50)
    try {
      const resp = await askCopilot(conv.id, q)
      setHistory(h => h.map((it, i) => i === h.length - 1
        ? { ...it, a: resp.answer, loading: false, model: resp.model, latency: resp.latency_ms, ctx: resp.context_used }
        : it
      ))
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50)
    } catch (e) {
      setError(e.message)
      setHistory(h => h.map((it, i) => i === h.length - 1
        ? { ...it, a: null, loading: false, error: e.message }
        : it
      ))
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  if (!conv) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>
        <span style={{ fontSize: 12 }}>Selecione uma conversa</span>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ao-bg)' }}>
      {/* Header contexto resumido */}
      <div style={{
        padding: '8px 14px', borderBottom: '1px solid var(--ao-border)',
        background: 'var(--ao-card)', fontSize: 11, color: 'var(--ao-text-dim)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Sparkles size={12} style={{ color: '#BA7517' }} />
          <span>Contexto: {conv.client_name || conv.display_phone}</span>
          {client && <span style={{ opacity: 0.7 }}>· {client.taxRegime || '--'}</span>}
        </div>
      </div>

      {/* Historico de perguntas/respostas */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {history.length === 0 && (
          <div style={{ padding: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Lightbulb size={12} />
              <span>Perguntas rápidas:</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {suggestedPrompts.map((p, i) => (
                <button
                  key={i}
                  onClick={() => handleAsk(p)}
                  disabled={loading}
                  style={{
                    textAlign: 'left', padding: '7px 10px', fontSize: 11.5,
                    borderRadius: 7, border: '1px solid var(--ao-border)',
                    background: 'var(--ao-card)', color: 'var(--ao-text-primary)',
                    cursor: loading ? 'wait' : 'pointer',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--ao-surface)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--ao-card)'}
                >
                  {p}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 12, fontSize: 10, color: 'var(--ao-text-dim)', fontStyle: 'italic' }}>
              O Copilot tem contexto: cliente Gesthub · 10 últimas msgs · RAG · tasks abertas.
              Nunca manda nada pro cliente — tudo fica entre você e a IA.
            </div>
          </div>
        )}

        {history.map((it, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            {/* Pergunta do operador */}
            <div style={{
              display: 'flex', justifyContent: 'flex-end', marginBottom: 5,
            }}>
              <div style={{
                maxWidth: '85%', padding: '6px 10px', borderRadius: 8,
                background: 'var(--ao-surface)', border: '1px solid var(--ao-border)',
                fontSize: 12, color: 'var(--ao-text-primary)',
              }}>
                {it.q}
              </div>
            </div>
            {/* Resposta da IA */}
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{
                maxWidth: '92%', padding: '8px 11px', borderRadius: 8,
                background: 'rgba(186, 117, 23, 0.08)',
                border: '1px solid rgba(186, 117, 23, 0.25)',
                fontSize: 12.5, color: 'var(--ao-text-primary)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.45,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4, fontSize: 10, fontWeight: 700, color: '#BA7517', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                  <Sparkles size={10} /> Copilot
                </div>
                {it.loading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.6 }}>
                    <Loader2 size={12} className="animate-spin" />
                    <span style={{ fontStyle: 'italic' }}>pensando...</span>
                  </div>
                ) : it.error ? (
                  <div style={{ color: '#ef4444', fontSize: 11 }}>Erro: {it.error}</div>
                ) : (
                  <>
                    {it.a}
                    {it.ctx && (
                      <div style={{ marginTop: 6, fontSize: 9.5, color: 'var(--ao-text-dim)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {it.ctx.cliente_linked && <span>✓ cliente</span>}
                        {it.ctx.msgs_count > 0 && <span>{it.ctx.msgs_count} msgs</span>}
                        {it.ctx.memorias_count > 0 && <span>{it.ctx.memorias_count} regras RAG</span>}
                        {it.ctx.tasks_count > 0 && <span>{it.ctx.tasks_count} tasks</span>}
                        {it.latency && <span>· {it.latency}ms</span>}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ padding: '6px 14px', fontSize: 11, color: '#ef4444', background: 'rgba(239, 68, 68, 0.08)' }}>
          {error}
        </div>
      )}

      {/* Input */}
      <div style={{
        padding: '8px 10px', borderTop: '1px solid var(--ao-border)',
        background: 'var(--ao-card)', display: 'flex', gap: 6, alignItems: 'flex-end',
      }}>
        <textarea
          ref={inputRef}
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleAsk()
            }
          }}
          placeholder="Pergunte sobre este cliente ou a conversa..."
          rows={1}
          style={{
            flex: 1, resize: 'none', minHeight: 34, maxHeight: 100,
            padding: '7px 10px', fontSize: 13, borderRadius: 7,
            border: '1px solid var(--ao-border)',
            background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={() => handleAsk()}
          disabled={!question.trim() || loading || !conv?.id}
          style={{
            padding: '8px 12px', borderRadius: 7, border: 'none',
            background: (question.trim() && !loading && conv?.id) ? 'linear-gradient(135deg, #BA7517, #A67B52)' : 'var(--ao-surface)',
            color: (question.trim() && !loading && conv?.id) ? '#fff' : 'var(--ao-text-dim)',
            fontSize: 12, fontWeight: 600,
            cursor: (question.trim() && !loading && conv?.id) ? 'pointer' : 'not-allowed',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            minHeight: 34,
          }}
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
        </button>
      </div>
    </div>
  )
}
