import { useState, useEffect } from 'react'
import { api } from '../lib/api'

const WORKSPACE_TABS = [
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'Diretoria', agent: 'Rodrigo', color: '#E8A955', letter: 'R' },
  { id: 'a0000001-0000-0000-0000-000000000002', name: 'Fiscal', agent: 'Campelo', color: '#4B9EF5', letter: 'C' },
  { id: 'a0000001-0000-0000-0000-000000000003', name: 'Financeiro', agent: 'Sneijder', color: '#34D399', letter: 'S' },
  { id: 'a0000001-0000-0000-0000-000000000004', name: 'Atendimento', agent: 'Luna', color: '#F59E0B', letter: 'L' },
  { id: 'a0000001-0000-0000-0000-000000000005', name: 'Societário', agent: 'Sofia', color: '#A78BFA', letter: 'So' },
]

export default function HUD({ agents, selectedAgent, onSelectAgent, onCloseAgent }) {
  const [time, setTime] = useState(new Date())
  const [stats, setStats] = useState(null)

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    api.getStats().then(setStats).catch(() => {})
    const interval = setInterval(() => {
      api.getStats().then(setStats).catch(() => {})
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  const taskCount = stats ? (stats.tasks?.pending || 0) + (stats.tasks?.in_progress || 0) : 0
  const onlineCount = agents?.filter(a => a.status === 'online').length || 0

  const handleTabClick = (tab) => {
    if (selectedAgent?.id === tab.id) {
      onCloseAgent()
    } else {
      const agent = agents?.find(a => a.id === tab.id)
      if (agent) onSelectAgent(agent)
    }
  }

  return (
    <div className="relative z-10">
      {/* Top bar with tabs */}
      <div className="flex items-center h-10 bg-[#0D1117] border-b border-white/5">
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 h-full border-r border-white/5 shrink-0">
          <div className="w-5 h-5 rounded bg-[#E8A955]/20 flex items-center justify-center">
            <span className="text-[#E8A955] text-[10px] font-bold">A</span>
          </div>
          <span className="text-white/70 text-xs font-semibold tracking-wider">Pixel Agents</span>
        </div>

        {/* Workspace tabs */}
        <div className="flex items-center h-full flex-1 overflow-x-auto">
          {WORKSPACE_TABS.map(tab => {
            const isActive = selectedAgent?.id === tab.id
            const agentData = agents?.find(a => a.id === tab.id)
            const isOnline = agentData?.status === 'online'

            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab)}
                className={`flex items-center gap-2 h-full px-4 text-xs transition-all relative shrink-0
                  ${isActive
                    ? 'text-white bg-white/5'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/[0.02]'
                  }`}
              >
                {/* Agent letter avatar */}
                <span
                  className="w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center"
                  style={{
                    backgroundColor: `${tab.color}20`,
                    color: isActive ? tab.color : `${tab.color}88`,
                  }}
                >
                  {tab.letter}
                </span>

                {/* Tab name */}
                <span className="font-medium">{tab.name}</span>

                {/* Status dot */}
                <span
                  className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-green-400' : 'bg-white/20'}`}
                  style={isOnline ? { boxShadow: '0 0 4px rgba(74, 222, 128, 0.5)' } : {}}
                />

                {/* Active indicator */}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full"
                    style={{ backgroundColor: tab.color }}
                  />
                )}
              </button>
            )
          })}
        </div>

        {/* Right: stats + clock */}
        <div className="flex items-center gap-3 px-4 h-full border-l border-white/5 shrink-0">
          <span className="text-white/25 text-[10px]">{taskCount} tasks</span>
          <span className="w-px h-3 bg-white/10" />
          <span className="text-white/40 text-[10px] font-mono">
            {time.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>

    </div>
  )
}
