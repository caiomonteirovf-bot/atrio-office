import { useState, useRef, useEffect } from 'react'
import { useChat } from '../hooks/useChat'

export default function ChatPanel({ agent, onClose }) {
  const [input, setInput] = useState('')
  const { messages, loading, sendMessage, clearChat } = useChat(agent.id)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  const color = agent.config?.color || '#6366f1'
  const letter = agent.config?.avatar_letter || agent.name[0]

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    inputRef.current?.focus()
  }, [agent.id])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!input.trim()) return
    sendMessage(input)
    setInput('')
  }

  return (
    <div className="flex flex-col h-full" style={{ background: `linear-gradient(180deg, var(--ao-topbar) 0%, var(--ao-bg) 100%)` }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5 shrink-0" style={{ borderBottom: `1px solid var(--ao-border-subtle)` }}>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-[13px]"
          style={{
            background: `linear-gradient(135deg, ${color}20 0%, ${color}08 100%)`,
            color,
            border: `1px solid ${color}15`,
          }}>
          {letter}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[13px] font-semibold" style={{ fontFamily: 'Outfit', color: 'var(--ao-text-primary)' }}>{agent.name}</h3>
          <p className="text-[10px]" style={{ color: 'var(--ao-text-dim)' }}>{agent.role}</p>
        </div>
        <button onClick={clearChat}
          className="p-1.5 rounded-lg transition-all text-[11px] cursor-pointer"
          style={{ color: 'var(--ao-text-xs)', border: '1px solid transparent' }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--ao-border)'; e.currentTarget.style.color = 'var(--ao-text-muted)' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--ao-text-xs)' }}>
          {'\u21BB'}
        </button>
        <button onClick={onClose}
          className="p-1.5 rounded-lg transition-all text-[11px] cursor-pointer"
          style={{ color: 'var(--ao-text-xs)', border: '1px solid transparent' }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--ao-border)'; e.currentTarget.style.color = 'var(--ao-text-muted)' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--ao-text-xs)' }}>
          {'\u2715'}
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 chat-scroll">
        {messages.length === 0 && (
          <div className="text-center mt-16">
            <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center font-bold text-lg"
              style={{
                background: `linear-gradient(135deg, ${color}10 0%, ${color}05 100%)`,
                color,
                border: `1px solid ${color}10`,
              }}>
              {letter}
            </div>
            <p className="text-[12px]" style={{ color: 'var(--ao-text-dim)' }}>Conversa com <span style={{ color: 'var(--ao-text-secondary)' }}>{agent.name}</span></p>
            <p className="text-[10px] mt-1.5 max-w-[250px] mx-auto leading-relaxed" style={{ color: 'var(--ao-text-xs)' }}>{agent.personality?.substring(0, 100)}</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-slide-in`}>
            <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed`}
              style={{
                background: msg.role === 'user'
                  ? `linear-gradient(135deg, ${color}15 0%, ${color}08 100%)`
                  : msg.role === 'system'
                    ? 'rgba(239, 68, 68, 0.06)'
                    : 'var(--ao-input-bg)',
                border: msg.role === 'user'
                  ? `1px solid ${color}20`
                  : msg.role === 'system'
                    ? '1px solid rgba(239, 68, 68, 0.08)'
                    : `1px solid var(--ao-border-subtle)`,
                color: msg.role === 'system' ? 'rgba(239, 68, 68, 0.6)' : 'var(--ao-text-secondary)',
              }}>
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded-xl px-4 py-3 flex gap-1.5"
              style={{ background: 'var(--ao-input-bg)', border: `1px solid var(--ao-border-subtle)` }}>
              <span className="typing-dot w-1.5 h-1.5 rounded-full" style={{ background: `${color}60` }} />
              <span className="typing-dot w-1.5 h-1.5 rounded-full" style={{ background: `${color}60` }} />
              <span className="typing-dot w-1.5 h-1.5 rounded-full" style={{ background: `${color}60` }} />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="px-4 py-3 shrink-0" style={{ borderTop: `1px solid var(--ao-border-subtle)` }}>
        <div className="flex items-center gap-2 rounded-xl px-3.5 py-1.5 transition-all duration-200"
          style={{ background: 'var(--ao-input-bg)', border: `1px solid var(--ao-input-border)` }}>
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={`Falar com ${agent.name}...`} disabled={loading}
            className="flex-1 bg-transparent text-[12px] outline-none py-1.5"
            style={{ color: 'var(--ao-text-secondary)', '--tw-placeholder-opacity': 1 }}
          />
          <button type="submit" disabled={!input.trim() || loading}
            className="p-1.5 rounded-md transition-all disabled:opacity-20 cursor-pointer"
            style={{ color }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  )
}
