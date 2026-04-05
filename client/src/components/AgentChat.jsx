import { useState, useEffect, useRef, useCallback } from 'react'

const AGENT_COLORS = {
  'Caio': '#C4956A',
  'Rodrigo': '#C4956A',
  'Campelo': '#378ADD',
  'Sneijder': '#639922',
  'Luna': '#BA7517',
  'Sofia': '#7F77DD',
  'Valência': '#E05A33',
  'Maia': '#D946A8',
  'Sistema': '#64748b',
}

const AGENT_ROLES = {
  'Caio': 'CEO',
  'Rodrigo': 'Diretor de Operações',
  'Campelo': 'Analista Fiscal',
  'Sneijder': 'Analista Financeiro',
  'Luna': 'Gestora de Atendimento',
  'Sofia': 'Analista Societário',
  'Valência': 'Gestor Comercial',
  'Maia': 'Estrategista Marketing',
  'Sistema': 'Sistema',
}

const AGENT_LETTERS = {
  'Caio': 'CM',
  'Rodrigo': 'R',
  'Campelo': 'C',
  'Sneijder': 'S',
  'Luna': 'L',
  'Sofia': 'So',
  'Valência': 'V',
  'Maia': 'M',
  'Sistema': '\u2699',
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function formatDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (d.toDateString() === today.toDateString()) return 'Hoje'
  if (d.toDateString() === yesterday.toDateString()) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

function AgentAvatar({ name, size = 32 }) {
  const color = AGENT_COLORS[name] || '#64748b'
  const letter = AGENT_LETTERS[name] || name?.[0] || '?'
  return (
    <div
      className="rounded-xl flex items-center justify-center font-bold shrink-0 relative"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${color}25 0%, ${color}10 100%)`,
        color: color,
        fontSize: size * 0.38,
        border: `1px solid ${color}20`,
      }}
    >
      {letter}
      {/* Online indicator */}
      <span
        className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}60`, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--ao-surface)' }}
      />
    </div>
  )
}

function TypingIndicator({ agentName }) {
  const color = AGENT_COLORS[agentName] || '#64748b'
  return (
    <div className="flex gap-2.5 items-start animate-fade-slide-in px-1">
      <AgentAvatar name={agentName} size={28} />
      <div className="flex-1 min-w-0">
        <span className="text-[11px] font-semibold" style={{ color }}>{agentName}</span>
        <div className="flex items-center gap-1 mt-1.5 px-3 py-2 rounded-xl w-fit"
          style={{ background: `${color}08`, border: `1px solid ${color}10` }}>
          <span className="typing-wave-dot w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="typing-wave-dot w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="typing-wave-dot w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
        </div>
      </div>
    </div>
  )
}

function DateDivider({ date }) {
  return (
    <div className="flex items-center gap-3 my-3">
      <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, transparent, var(--ao-border-subtle), transparent)` }} />
      <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--ao-text-xs)' }}>{date}</span>
      <div className="flex-1 h-px" style={{ background: `linear-gradient(to right, transparent, var(--ao-border-subtle), transparent)` }} />
    </div>
  )
}

function ChatBubble({ msg, isNew, showAvatar, isFirstInGroup }) {
  const color = AGENT_COLORS[msg.from] || '#64748b'
  const isSystem = msg.type === 'system'
  const role = AGENT_ROLES[msg.from] || ''

  if (isSystem) {
    return (
      <div className="flex justify-center my-3">
        <span className="text-[10px] backdrop-blur-sm px-4 py-1.5 rounded-full"
          style={{ color: 'var(--ao-text-dim)', background: 'var(--ao-input-bg)', border: `1px solid var(--ao-border-subtle)` }}>
          {msg.text}
        </span>
      </div>
    )
  }

  return (
    <div className={`flex gap-2.5 items-start group ${isNew ? 'animate-fade-slide-in' : ''} ${!isFirstInGroup ? 'mt-0.5' : 'mt-3'}`}>
      {/* Avatar — only show for first message in a group */}
      <div className="w-8 shrink-0">
        {isFirstInGroup && <AgentAvatar name={msg.from} size={32} />}
      </div>

      <div className="flex-1 min-w-0">
        {/* Name + arrow + time — only for first in group */}
        {isFirstInGroup && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[12px] font-bold" style={{ color }}>{msg.from}</span>
            {role && <span className="text-[10px] hidden group-hover:inline" style={{ color: 'var(--ao-text-xs)' }}>{role}</span>}
            {msg.to && (
              <>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-30">
                  <path d="M4 6h4M6.5 4L8 6l-1.5 2" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="text-[11px] font-medium" style={{ color: AGENT_COLORS[msg.to] || '#64748b' }}>{msg.to}</span>
              </>
            )}
            <span className="text-[10px] ml-auto opacity-0 group-hover:opacity-100 transition-opacity duration-200" style={{ color: 'var(--ao-text-xs)' }}>
              {formatTime(msg.timestamp)}
            </span>
          </div>
        )}

        {/* Message bubble */}
        <div
          className={`relative rounded-xl px-3.5 py-2 text-[12.5px] leading-relaxed w-fit max-w-full transition-all duration-300 ${isNew ? 'animate-message-glow' : ''}`}
          style={{
            background: `linear-gradient(135deg, ${color}08 0%, ${color}04 100%)`,
            border: `1px solid ${color}0d`,
          }}
        >
          <p style={{ color: 'var(--ao-text-secondary)' }}>{msg.text}</p>
        </div>

        {/* Tags */}
        {msg.tag && (
          <span
            className="inline-flex items-center text-[9px] font-semibold px-2 py-0.5 rounded-md mt-1.5 uppercase tracking-wider"
            style={{ backgroundColor: `${color}10`, color: `${color}99`, border: `1px solid ${color}15` }}
          >
            {msg.tag}
          </span>
        )}
      </div>
    </div>
  )
}

function OnlineAgents() {
  const agents = Object.entries(AGENT_COLORS).filter(([name]) => name !== 'Sistema')
  return (
    <div className="flex items-center gap-1 px-4 py-2.5" style={{ borderBottom: `1px solid var(--ao-border-subtle)` }}>
      <span className="text-[10px] mr-2 uppercase tracking-wider font-medium" style={{ color: 'var(--ao-text-xs)' }}>Online</span>
      <div className="flex -space-x-1.5">
        {agents.map(([name, color]) => (
          <div
            key={name}
            className="w-6 h-6 rounded-lg flex items-center justify-center text-[9px] font-bold"
            style={{ background: `${color}20`, color: color, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--ao-surface)' }}
            title={name}
          >
            {AGENT_LETTERS[name]}
          </div>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(52,211,153,0.5)' }} />
        <span className="text-[10px] text-emerald-400/70">{agents.length} ativos</span>
      </div>
    </div>
  )
}

const MENTION_AGENTS = ['Rodrigo', 'Campelo', 'Sneijder', 'Luna', 'Sofia', 'Valência', 'Maia']

function detectMention(text) {
  const lower = text.toLowerCase()
  for (const name of MENTION_AGENTS) {
    if (lower.includes(name.toLowerCase()) || lower.includes(`@${name.toLowerCase()}`)) return name
  }
  return null
}

export default function AgentChat({ lastMessage }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [newMsgIds, setNewMsgIds] = useState(new Set())
  const [typingAgent, setTypingAgent] = useState(null)
  const [inputText, setInputText] = useState('')
  const [sending, setSending] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const bottomRef = useRef(null)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const sentMsgIds = useRef(new Set())

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || sending) return

    // Detect target agent
    const targetAgent = detectMention(text) || 'Rodrigo'

    // Add CEO message locally immediately
    const ceoMsgId = `ceo-${Date.now()}`
    sentMsgIds.current.add(ceoMsgId)
    const ceoMsg = {
      id: ceoMsgId,
      from: 'Caio',
      to: targetAgent,
      text,
      timestamp: new Date().toISOString(),
      tag: 'ceo',
    }
    setMessages(prev => [...prev.slice(-99), ceoMsg])
    setNewMsgIds(prev => new Set([...prev, ceoMsgId]))
    setTimeout(() => setNewMsgIds(prev => { const n = new Set(prev); n.delete(ceoMsgId); return n }), 2500)

    setSending(true)
    setInputText('')
    setMentionOpen(false)

    // Show typing indicator for target agent
    setTypingAgent(targetAgent)

    try {
      const res = await fetch('/api/agent-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, to: targetAgent }),
      })
      if (!res.ok) console.error('Erro ao enviar:', res.status)
    } catch (err) {
      console.error('Erro ao enviar mensagem:', err)
      setTypingAgent(null)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  // Handle input change with @ mention detection
  const handleInputChange = (e) => {
    const val = e.target.value
    setInputText(val)

    // Check for @ at the end of the text
    const atMatch = val.match(/@(\w*)$/)
    if (atMatch) {
      setMentionOpen(true)
      setMentionFilter(atMatch[1].toLowerCase())
      setMentionIndex(0)
    } else {
      setMentionOpen(false)
    }
  }

  const filteredMentions = MENTION_AGENTS.filter(n => n.toLowerCase().startsWith(mentionFilter))

  const insertMention = (name) => {
    const newText = inputText.replace(/@\w*$/, `@${name} `)
    setInputText(newText)
    setMentionOpen(false)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e) => {
    if (mentionOpen && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex(i => (i + 1) % filteredMentions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex(i => (i - 1 + filteredMentions.length) % filteredMentions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filteredMentions[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        setMentionOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !mentionOpen) {
      e.preventDefault()
      handleSend()
    }
  }

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const threshold = 60
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold)
  }, [])

  // Carrega historico
  useEffect(() => {
    fetch('/api/agent-chat')
      .then(r => r.json())
      .then(data => {
        setMessages(data.messages || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Recebe updates em tempo real via WebSocket
  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'agent_chat') return
    const newMsg = lastMessage.message

    // Skip CEO messages we already added locally
    if (newMsg.from === 'Caio' && newMsg.tag === 'ceo') return

    // If this is an agent replying to the CEO, clear typing immediately and show
    if (newMsg.to === 'Caio') {
      setTypingAgent(null)
      setMessages(prev => [...prev.slice(-99), newMsg])
      const msgId = newMsg.id || Date.now()
      setNewMsgIds(prev => new Set([...prev, msgId]))
      setTimeout(() => setNewMsgIds(prev => { const n = new Set(prev); n.delete(msgId); return n }), 2500)
      return
    }

    // Normal agent-to-agent messages: simulate typing
    setTypingAgent(newMsg.from)
    const typingDuration = 600 + Math.random() * 800

    const timer = setTimeout(() => {
      setTypingAgent(null)
      setMessages(prev => [...prev.slice(-99), newMsg])

      const msgId = newMsg.id || Date.now()
      setNewMsgIds(prev => new Set([...prev, msgId]))
      setTimeout(() => {
        setNewMsgIds(prev => {
          const next = new Set(prev)
          next.delete(msgId)
          return next
        })
      }, 2500)
    }, typingDuration)

    return () => clearTimeout(timer)
  }, [lastMessage])

  // Auto-scroll only if user is at bottom
  useEffect(() => {
    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, typingAgent, isAtBottom])

  // Group messages by date
  const groupedMessages = messages.reduce((groups, msg) => {
    const date = formatDate(msg.timestamp)
    if (!groups.length || groups[groups.length - 1].date !== date) {
      groups.push({ date, messages: [msg] })
    } else {
      groups[groups.length - 1].messages.push(msg)
    }
    return groups
  }, [])

  return (
    <div className="flex flex-col h-full glass-card rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3.5 shrink-0" style={{ borderBottom: `1px solid var(--ao-border-subtle)` }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #C4956A20 0%, #C4956A08 100%)', border: '1px solid #C4956A15' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C4956A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-[13px] font-bold" style={{ fontFamily: 'Outfit', color: 'var(--ao-text-primary)' }}>
                Comunicacao da Equipe
              </h2>
              <p className="text-[10px]" style={{ color: 'var(--ao-text-dim)' }}>{messages.length} interacoes</p>
            </div>
          </div>
          {/* Live indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/[0.08] border border-emerald-500/10">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 glow-breathe" style={{ color: '#22c55e' }} />
            <span className="text-[10px] text-emerald-400/80 font-medium">Ao vivo</span>
          </div>
        </div>
      </div>

      {/* Online agents strip */}
      <OnlineAgents />

      {/* Messages area */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 chat-scroll"
      >
        {loading && (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="flex gap-1.5">
              <span className="typing-wave-dot w-2 h-2 rounded-full bg-[#C4956A]" />
              <span className="typing-wave-dot w-2 h-2 rounded-full bg-[#C4956A]" />
              <span className="typing-wave-dot w-2 h-2 rounded-full bg-[#C4956A]" />
            </div>
            <span className="text-[11px]" style={{ color: 'var(--ao-text-xs)' }}>Carregando conversas...</span>
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #C4956A10 0%, #C4956A05 100%)', border: '1px solid #C4956A10' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C4956A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-50">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
              </svg>
            </div>
            <div>
              <span className="text-[12px] block" style={{ color: 'var(--ao-text-dim)' }}>Nenhuma interacao ainda</span>
              <span className="text-[10px] block mt-1" style={{ color: 'var(--ao-text-xs)' }}>As conversas entre agentes aparecerao aqui em tempo real</span>
            </div>
          </div>
        )}

        {/* Messages grouped by date */}
        {groupedMessages.map((group, gi) => (
          <div key={gi}>
            <DateDivider date={group.date} />
            {group.messages.map((msg, mi) => {
              const prevMsg = mi > 0 ? group.messages[mi - 1] : null
              const isFirstInGroup = !prevMsg || prevMsg.from !== msg.from || prevMsg.type === 'system'
              return (
                <ChatBubble
                  key={msg.id || `${gi}-${mi}`}
                  msg={msg}
                  isNew={newMsgIds.has(msg.id)}
                  showAvatar={isFirstInGroup}
                  isFirstInGroup={isFirstInGroup}
                />
              )
            })}
          </div>
        ))}

        {/* Typing indicator */}
        {typingAgent && <TypingIndicator agentName={typingAgent} />}

        <div ref={bottomRef} className="h-1" />
      </div>

      {/* Scroll to bottom indicator */}
      {!isAtBottom && messages.length > 5 && (
        <button
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
          className="absolute bottom-16 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-[10px] font-medium bg-[#C4956A]/20 text-[#C4956A] border border-[#C4956A]/20 backdrop-blur-sm hover:bg-[#C4956A]/30 transition-all cursor-pointer z-10"
        >
          Novas mensagens
        </button>
      )}

      {/* CEO input */}
      <div className="px-3 py-2.5 shrink-0 relative" style={{ borderTop: `1px solid var(--ao-border-subtle)` }}>
        {/* @ Mention popup */}
        {mentionOpen && filteredMentions.length > 0 && (
          <div className="absolute bottom-full left-12 mb-1 py-1 rounded-xl z-20"
            style={{ background: 'var(--ao-popup-bg)', border: `1px solid var(--ao-border-hover)`, minWidth: 180, boxShadow: '0 4px 16px var(--ao-shadow)' }}>
            {filteredMentions.map((name, i) => (
              <button
                key={name}
                onClick={() => insertMention(name)}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors"
                style={{ background: i === mentionIndex ? 'var(--ao-badge-bg)' : 'transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ao-hover-bg)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = i === mentionIndex ? 'var(--ao-badge-bg)' : 'transparent' }}
              >
                <AgentAvatar name={name} size={22} />
                <div>
                  <span className="text-[11px] font-semibold" style={{ color: AGENT_COLORS[name] }}>{name}</span>
                  <span className="text-[9px] ml-1.5" style={{ color: 'var(--ao-text-dim)' }}>{AGENT_ROLES[name]}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <AgentAvatar name="Caio" size={26} />
          <div className="flex-1 flex items-center gap-2 rounded-xl px-3 py-2"
            style={{ background: 'var(--ao-input-bg)', border: `1px solid var(--ao-input-border)` }}>
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Pergunte algo aos agentes... (@ para mencionar)"
              disabled={sending}
              className="flex-1 bg-transparent text-[12px] outline-none"
              style={{ color: 'var(--ao-text-secondary)' }}
            />
            <button
              onClick={handleSend}
              disabled={!inputText.trim() || sending}
              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-200 disabled:opacity-20"
              style={{
                background: inputText.trim() ? '#C4956A20' : 'transparent',
                color: '#C4956A',
              }}
            >
              {sending ? (
                <span className="w-3 h-3 border border-[#C4956A] border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          </div>
        </div>
        {!mentionOpen && (
          <p className="text-[9px] mt-1.5 ml-9" style={{ color: 'var(--ao-text-xs)' }}>
            Digite @ para mencionar um agente — sem menção, Rodrigo responde
          </p>
        )}
      </div>
    </div>
  )
}
