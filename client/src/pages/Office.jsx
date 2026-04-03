import { useState } from 'react'
import AgentCard from '../components/AgentCard'
import ChatPanel from '../components/ChatPanel'
import TaskBoard from '../components/TaskBoard'
import StatsBar from '../components/StatsBar'
import { useAgents } from '../hooks/useAgents'

export default function Office() {
  const { agents, loading, error } = useAgents()
  const [selectedAgent, setSelectedAgent] = useState(null)

  const handleSelectAgent = (agent) => {
    console.log('[Office] Agent selected:', agent.name, agent.id)
    setSelectedAgent(agent)
  }

  console.log('[Office] render, selectedAgent:', selectedAgent?.name || 'none')

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main content */}
      <div className={`flex-1 overflow-y-auto p-6 space-y-6 ${selectedAgent ? 'max-w-[calc(100%-400px)]' : ''}`}>
        {/* Stats */}
        <StatsBar />

        {/* Agents section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-text-primary font-semibold text-sm">Equipe IA</h2>
            <span className="text-text-muted text-xs">
              {agents.filter(a => a.status === 'online').length}/{agents.length} online
            </span>
          </div>

          {loading && (
            <div className="text-text-muted text-sm">Carregando agentes...</div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400 text-sm">
              Erro ao carregar agentes: {error}
              <p className="text-xs mt-1 text-red-400/70">Verifique se o backend está rodando em localhost:3010</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {agents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onClick={handleSelectAgent}
              />
            ))}
          </div>
        </section>

        {/* Humans section */}
        <section>
          <h2 className="text-text-primary font-semibold text-sm mb-3">Colaboradores</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { name: 'Deyvison', role: 'Coordenador operacional', dept: 'Operacional', status: 'available' },
              { name: 'Diego', role: 'Assistente contábil', dept: 'Operacional', status: 'available' },
            ].map(member => (
              <div key={member.name} className="bg-void-light border border-void-border rounded-xl p-4">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-lg bg-void-lighter flex items-center justify-center text-text-secondary font-medium text-sm">
                    {member.name[0]}
                  </div>
                  <div>
                    <h3 className="text-text-primary font-medium text-sm">{member.name}</h3>
                    <p className="text-text-secondary text-xs">{member.role}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-text-muted text-xs">Disponível</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Tasks section */}
        <section>
          <h2 className="text-text-primary font-semibold text-sm mb-3">Tarefas recentes</h2>
          <TaskBoard />
        </section>
      </div>

      {/* Chat panel */}
      {selectedAgent && (
        <div className="w-[400px] h-full shrink-0">
          <ChatPanel
            agent={selectedAgent}
            onClose={() => setSelectedAgent(null)}
          />
        </div>
      )}
    </div>
  )
}
