import { useState } from 'react'
import { useAgents } from './hooks/useAgents'
import { useWebSocket } from './hooks/useWebSocket'
import TopBar from './components/TopBar'
import AgentCard from './components/AgentCard'
import ChatPanel from './components/ChatPanel'
import ActivityFeed from './components/ActivityFeed'
import StatsBar from './components/StatsBar'
import WhatsAppStatus from './components/WhatsAppStatus'
import AttendanceQueue from './components/AttendanceQueue'
import PortalLogin from './portal/PortalLogin'
import PortalDashboard from './portal/PortalDashboard'

function AdminDashboard() {
  const { agents } = useAgents()
  const { connected } = useWebSocket()
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [activeTab, setActiveTab] = useState('all')

  const filteredAgents = activeTab === 'all'
    ? agents
    : agents.filter(a => a.department === activeTab)

  return (
    <div className="flex h-screen bg-[#0f172a] text-slate-200 overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar agents={agents} activeTab={activeTab} onTabChange={setActiveTab} connected={connected} />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[1400px] mx-auto px-6 py-5 space-y-6">
            <StatsBar />
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">
                  {activeTab === 'all' ? 'Equipe' : filteredAgents[0]?.department || 'Setor'}
                </h2>
                <span className="text-[11px] text-slate-500">
                  {agents.filter(a => a.status === 'online').length}/{agents.length} online
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredAgents.map(agent => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    isSelected={selectedAgent?.id === agent.id}
                    onClick={() => setSelectedAgent(selectedAgent?.id === agent.id ? null : agent)}
                  />
                ))}
              </div>
            </section>
            <AttendanceQueue />
            <ActivityFeed agents={agents} />
          </div>
        </div>
      </div>
      {selectedAgent && (
        <div className="w-[420px] shrink-0 h-full border-l border-slate-700/50">
          <ChatPanel agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
        </div>
      )}
    </div>
  )
}

export default function App() {
  // Roteamento simples: /portal → portal do cliente, / → admin
  const isPortal = window.location.pathname.startsWith('/portal')
  const [portalClient, setPortalClient] = useState(null)

  if (isPortal) {
    if (!portalClient) {
      return <PortalLogin onLogin={setPortalClient} />
    }
    return <PortalDashboard clientBasic={portalClient} onLogout={() => setPortalClient(null)} />
  }

  return <AdminDashboard />
}
