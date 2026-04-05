import { useState, useEffect, createContext, useContext } from 'react'
import { useAgents } from './hooks/useAgents'
import { useWebSocket } from './hooks/useWebSocket'
import TopBar from './components/TopBar'
import AgentCard from './components/AgentCard'
import ChatPanel from './components/ChatPanel'
import ActivityFeed from './components/ActivityFeed'
import StatsBar from './components/StatsBar'
import AttendanceQueue from './components/AttendanceQueue'
import AgentChat from './components/AgentChat'
import PortalLogin from './portal/PortalLogin'
import PortalDashboard from './portal/PortalDashboard'

export const ThemeContext = createContext()

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('atrio-office-theme') || 'dark')
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('atrio-office-theme', theme)
  }, [theme])
  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark')
  return { theme, toggle }
}

function AdminDashboard() {
  const { agents, refresh } = useAgents()
  const { connected, lastMessage } = useWebSocket()

  // Atualiza estado dos agentes em tempo real via WebSocket
  useEffect(() => {
    if (!lastMessage) return
    const { type } = lastMessage
    if (type === 'task_completed' || type === 'task_blocked' || type === 'task_updated') {
      refresh()
    }
  }, [lastMessage, refresh])
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [reportLoading, setReportLoading] = useState(false)

  async function handleAction(actionId) {
    if (actionId === 'relatorio') {
      setReportLoading(true)
      try {
        const res = await fetch('/api/daily-report', { method: 'POST' })
        const data = await res.json()
        if (data.report) {
          alert('Relatorio gerado e enviado no Telegram!')
        } else {
          alert(data.error || 'Erro ao gerar relatorio')
        }
      } catch {
        alert('Erro de conexao ao gerar relatorio')
      } finally {
        setReportLoading(false)
      }
    } else if (actionId === 'notas') {
      alert('Painel de notas em desenvolvimento')
    }
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--ao-bg)', color: 'var(--ao-text)', transition: 'background 0.3s, color 0.3s' }}>
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar agents={agents} connected={connected} onAction={handleAction} />

        {/* Main content: two-column layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* LEFT COLUMN — 60% */}
          <div className="flex-1 overflow-y-auto" style={{ minWidth: 0 }}>
            <div className="max-w-[960px] mx-auto px-5 py-5 space-y-5">
              <StatsBar />

              {/* Agent Cards Grid */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="section-header">Equipe</h2>
                  <span className="text-[11px] tabular-nums" style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-xs)' }}>
                    {agents.filter(a => a.status === 'online').length}/{agents.length} online
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {agents.map(agent => (
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
              <ActivityFeed />

              {/* Bottom spacer */}
              <div className="h-4" />
            </div>
          </div>

          {/* RIGHT COLUMN — Agent Chat (tall panel, always visible) */}
          <div className="w-[400px] xl:w-[440px] shrink-0 h-full flex flex-col p-3 pl-0"
            style={{ borderLeft: `1px solid var(--ao-border)` }}>
            <AgentChat lastMessage={lastMessage} />
          </div>
        </div>
      </div>

      {/* Chat Panel overlay when agent is selected */}
      {selectedAgent && (
        <div className="w-[420px] shrink-0 h-full" style={{ borderLeft: `1px solid var(--ao-border)` }}>
          <ChatPanel agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const themeState = useTheme()
  // Roteamento simples: /portal -> portal do cliente, / -> admin
  const isPortal = window.location.pathname.startsWith('/portal')
  const [portalClient, setPortalClient] = useState(null)

  return (
    <ThemeContext.Provider value={themeState}>
      {isPortal ? (
        !portalClient
          ? <PortalLogin onLogin={setPortalClient} />
          : <PortalDashboard clientBasic={portalClient} onLogout={() => setPortalClient(null)} />
      ) : (
        <AdminDashboard />
      )}
    </ThemeContext.Provider>
  )
}
