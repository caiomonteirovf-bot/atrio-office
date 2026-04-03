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
    <div className="flex flex-col h-full bg-[#1e293b]/50">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/40 shrink-0">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[12px]"
          style={{ backgroundColor: `${color}15`, color }}>
          {letter}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[13px] font-semibold text-slate-100">{agent.name}</h3>
          <p className="text-[10px] text-slate-500">{agent.role}</p>
        </div>
        <button onClick={clearChat} className="p-1.5 rounded-md text-slate-600 hover:text-slate-400 hover:bg-slate-700/50 transition-all text-[11px]">↻</button>
        <button onClick={onClose} className="p-1.5 rounded-md text-slate-600 hover:text-slate-400 hover:bg-slate-700/50 transition-all text-[11px]">✕</button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center mt-16">
            <div className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center font-bold text-lg"
              style={{ backgroundColor: `${color}10`, color }}>
              {letter}
            </div>
            <p className="text-slate-400 text-[12px]">Conversa com <span className="text-slate-200">{agent.name}</span></p>
            <p className="text-slate-600 text-[10px] mt-1 max-w-[250px] mx-auto">{agent.personality?.substring(0, 100)}</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed
              ${msg.role === 'user'
                ? 'bg-indigo-600/20 text-slate-200 border border-indigo-500/20'
                : msg.role === 'system'
                  ? 'bg-red-500/10 text-red-300/80'
                  : 'bg-slate-800/60 text-slate-300 border border-slate-700/30'
              }`}>
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-800/60 border border-slate-700/30 rounded-xl px-4 py-3 flex gap-1.5">
              <span className="typing-dot w-1.5 h-1.5 bg-slate-500 rounded-full" />
              <span className="typing-dot w-1.5 h-1.5 bg-slate-500 rounded-full" />
              <span className="typing-dot w-1.5 h-1.5 bg-slate-500 rounded-full" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-slate-700/40 shrink-0">
        <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/40 rounded-xl px-3.5 py-1.5 focus-within:border-indigo-500/30 transition-colors">
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={`Falar com ${agent.name}...`} disabled={loading}
            className="flex-1 bg-transparent text-[12px] text-slate-200 placeholder:text-slate-600 outline-none py-1.5" />
          <button type="submit" disabled={!input.trim() || loading}
            className="p-1.5 rounded-md transition-all disabled:text-slate-700 text-indigo-400 hover:text-indigo-300">
            ➤
          </button>
        </div>
      </form>
    </div>
  )
}
