import { useState, useEffect, useRef, useCallback } from 'react'

export default function GlobalSearch({ isOpen, onClose, onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ agents: [], tasks: [], clients: [] })
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef(null)

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setResults({ agents: [], tasks: [], clients: [] })
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Search with debounce
  useEffect(() => {
    if (!query.trim()) { setResults({ agents: [], tasks: [], clients: [] }); return }
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const q = encodeURIComponent(query.trim())
        const [agentsRes, tasksRes, clientsRes] = await Promise.all([
          fetch(`/api/agents`).then(r => r.json()),
          fetch(`/api/tasks?search=${q}`).then(r => r.json()).catch(() => []),
          fetch(`/api/clients?search=${q}`).then(r => r.json()).catch(() => []),
        ])
        // Filter agents by name locally
        const filteredAgents = (Array.isArray(agentsRes) ? agentsRes : []).filter(a =>
          a.name.toLowerCase().includes(query.toLowerCase()) ||
          a.role.toLowerCase().includes(query.toLowerCase())
        )
        setResults({
          agents: filteredAgents.slice(0, 5),
          tasks: (Array.isArray(tasksRes) ? tasksRes : tasksRes?.tasks || []).slice(0, 8),
          clients: (Array.isArray(clientsRes) ? clientsRes : []).slice(0, 5),
        })
      } catch (e) { console.error('Search error:', e) }
      finally { setLoading(false) }
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  // Get flat list of all results for keyboard nav
  const allResults = [
    ...results.agents.map(a => ({ type: 'agent', item: a, label: a.name, sub: a.role })),
    ...results.tasks.map(t => ({ type: 'task', item: t, label: t.title, sub: t.status })),
    ...results.clients.map(c => ({ type: 'client', item: c, label: c.name, sub: c.cnpj })),
  ]

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, allResults.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter' && allResults[selected]) { onSelect?.(allResults[selected].type, allResults[selected].item); onClose() }
    else if (e.key === 'Escape') { onClose() }
  }, [allResults, selected, onSelect, onClose])

  if (!isOpen) return null

  const ICONS = { agent: '\u{1F916}', task: '\u{1F4CB}', client: '\u{1F3E2}' }
  const COLORS = { agent: '#C4956A', task: '#60a5fa', client: '#22c55e' }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}>
      <div className="w-full max-w-[580px] rounded-2xl overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(19,22,32,0.95) 0%, rgba(19,22,32,0.9) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.5), 0 0 40px rgba(196,149,106,0.08)',
        }}
        onClick={e => e.stopPropagation()}>

        {/* Search input */}
        <div className="flex items-center gap-3 px-5 h-14" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C4956A" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Buscar agentes, tarefas, clientes..."
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[rgba(255,255,255,0.25)]"
            style={{ color: 'var(--ao-text-primary)', fontFamily: 'Plus Jakarta Sans' }}
          />
          <kbd className="px-2 py-0.5 rounded text-[10px] font-medium"
            style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--ao-text-dim)', fontFamily: 'Space Grotesk' }}>
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto py-2" style={{ scrollbarWidth: 'thin' }}>
          {loading && (
            <div className="px-5 py-4 text-center text-[12px]" style={{ color: 'var(--ao-text-dim)' }}>Buscando...</div>
          )}

          {!loading && query && allResults.length === 0 && (
            <div className="px-5 py-8 text-center text-[13px]" style={{ color: 'var(--ao-text-dim)' }}>
              Nenhum resultado para &ldquo;{query}&rdquo;
            </div>
          )}

          {!loading && !query && (
            <div className="px-5 py-8 text-center text-[13px]" style={{ color: 'var(--ao-text-dim)' }}>
              <div className="text-[24px] mb-2">{'\u{1F50D}'}</div>
              Digite para buscar agentes, tarefas ou clientes
            </div>
          )}

          {['agents', 'tasks', 'clients'].map(cat => {
            const items = results[cat]
            if (!items.length) return null
            const catLabel = { agents: 'Agentes', tasks: 'Tarefas', clients: 'Clientes' }[cat]
            const catType = { agents: 'agent', tasks: 'task', clients: 'client' }[cat]
            return (
              <div key={cat}>
                <div className="px-5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: COLORS[catType], fontFamily: 'Space Grotesk' }}>
                  {catLabel}
                </div>
                {items.map((item, i) => {
                  const flatIdx = allResults.findIndex(r => r.item === item)
                  const isActive = flatIdx === selected
                  return (
                    <button key={item.id || i}
                      className="w-full flex items-center gap-3 px-5 py-2.5 text-left transition-all duration-150 cursor-pointer"
                      style={{
                        background: isActive ? 'rgba(196,149,106,0.1)' : 'transparent',
                        borderLeft: isActive ? '2px solid #C4956A' : '2px solid transparent',
                      }}
                      onClick={() => { onSelect?.(catType, item); onClose() }}
                      onMouseEnter={() => setSelected(flatIdx)}
                    >
                      <span className="text-[16px]">{ICONS[catType]}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--ao-text-primary)' }}>
                          {catType === 'agent' ? item.name : catType === 'task' ? item.title : item.name}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: 'var(--ao-text-dim)' }}>
                          {catType === 'agent' ? item.role : catType === 'task' ? item.status : (item.cnpj || item.trade_name || '')}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-5 py-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="text-[10px]" style={{ color: 'var(--ao-text-dim)', fontFamily: 'Space Grotesk' }}>
            {'\u2191\u2193'} navegar &nbsp; {'\u21B5'} selecionar &nbsp; esc fechar
          </span>
        </div>
      </div>
    </div>
  )
}
