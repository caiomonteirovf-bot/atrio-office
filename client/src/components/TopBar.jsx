import { useState, useEffect } from 'react'

const TABS = [
  { id: 'all', label: 'Escritório' },
  { id: 'diretoria', label: 'Diretoria' },
  { id: 'fiscal', label: 'Fiscal' },
  { id: 'financeiro', label: 'Financeiro' },
  { id: 'atendimento', label: 'Atendimento' },
  { id: 'societario', label: 'Societário' },
]

export default function TopBar({ agents, activeTab, onTabChange, connected }) {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const onlineCount = agents?.filter(a => a.status === 'online').length || 0

  return (
    <div className="flex items-center h-12 bg-[#1e293b]/80 backdrop-blur-sm border-b border-slate-700/40 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-full border-r border-slate-700/40">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <span className="text-white text-[11px] font-black">A</span>
        </div>
        <div>
          <span className="text-slate-100 text-[14px] font-semibold tracking-tight">Átrio</span>
          <span className="text-indigo-400 text-[14px] font-semibold tracking-tight ml-1">Office</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center h-full flex-1">
        {TABS.map(tab => {
          const isActive = activeTab === tab.id
          const deptAgents = tab.id === 'all' ? agents : agents?.filter(a => a.department === tab.id)
          const deptOnline = deptAgents?.filter(a => a.status === 'online').length || 0

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`relative flex items-center gap-2 h-full px-4 text-[12px] font-medium transition-all
                ${isActive ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {tab.label}
              {tab.id !== 'all' && deptOnline > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
              )}
              {isActive && (
                <span className="absolute bottom-0 left-3 right-3 h-[2px] rounded-t-full bg-indigo-500" />
              )}
            </button>
          )
        })}
      </div>

      {/* Right */}
      <div className="flex items-center gap-4 px-5 h-full border-l border-slate-700/40">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]' : 'bg-red-400'}`} />
          <span className="text-[11px] text-slate-400 font-mono">{onlineCount} agents</span>
        </div>
        <span className="text-[11px] text-slate-500 font-mono tabular-nums">
          {time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
    </div>
  )
}
