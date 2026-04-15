import { useState, useEffect, createContext, useContext } from 'react'
import { MessageCircle, X as XIcon } from 'lucide-react'
import { useAgents } from './hooks/useAgents'
import { useWebSocket } from './hooks/useWebSocket'
import TopBar from './components/TopBar'
import AgentCard from './components/AgentCard'
import ChatPanel from './components/ChatPanel'
import ActivityFeed from './components/ActivityFeed'
import StatsBar from './components/StatsBar'
import AttendanceQueue from './components/AttendanceQueue'
import AgentChat from './components/AgentChat'
import GlobalSearch from './components/GlobalSearch'
import StatusBar from './components/StatusBar'
import ActivityHeatmap from './components/ActivityHeatmap'
import CronManager from './components/CronManager'
import CostAnalytics from './components/CostAnalytics'
import SessionHistory from './components/SessionHistory'
import WeeklyCalendar from './components/WeeklyCalendar'
import MemoryBrowser from './components/MemoryBrowser'
import HybridMemory from './components/HybridMemory'
import ErrorBoundary from './components/ErrorBoundary'
import DatalakeViewer from './components/DatalakeViewer'
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
  const [searchOpen, setSearchOpen] = useState(false)
  const [currentPage, setCurrentPage] = useState('home')
  const [chatOpen, setChatOpen] = useState(false)
  // Paginas largas (datalake, memory) nao mostram chat fixo — usa floating
  const WIDE_PAGES = ['datalake', 'memory', 'crons', 'custos', 'sessions']
  const isWidePage = WIDE_PAGES.includes(currentPage)

  // Global search shortcut (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(s => !s)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  const [reportLoading, setReportLoading] = useState(false)
  const [reportData, setReportData] = useState(null)
  const [reportError, setReportError] = useState('')

  async function handleAction(actionId) {
    if (actionId === 'relatorio') {
      setReportLoading(true)
      setReportError('')
      setReportData(null)
      try {
        const res = await fetch('/api/daily-report', { method: 'POST' })
        const data = await res.json()
        if (data.report) {
          setReportData(data.report)
        } else {
          setReportError(data.error || 'Erro ao gerar relatorio')
        }
      } catch {
        setReportError('Erro de conexao ao gerar relatorio')
      } finally {
        setReportLoading(false)
      }
    }
  }

  return (
    <div className="flex h-[calc(100vh-28px)] overflow-hidden" style={{ background: 'var(--ao-bg)', color: 'var(--ao-text)', transition: 'background 0.3s, color 0.3s' }}>
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar agents={agents} connected={connected} onAction={handleAction} onSearchOpen={() => setSearchOpen(true)} currentPage={currentPage} onNavigate={setCurrentPage} />

        {/* Main content: two-column layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* LEFT COLUMN — 60% */}
          <div className="flex-1 overflow-y-auto" style={{ minWidth: 0 }}>
            {currentPage === 'home' && (
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
                <ActivityHeatmap />

                {/* Bottom spacer */}
                <div className="h-4" />
              </div>
            )}

            {currentPage === 'crons' && <CronManager />}
            {currentPage === 'custos' && <CostAnalytics />}
            {currentPage === 'sessions' && <SessionHistory />}
            {currentPage === 'calendar' && <WeeklyCalendar />}
            {currentPage === 'memory' && <ErrorBoundary label='HybridMemory'><HybridMemory /></ErrorBoundary>}
            {currentPage === 'datalake' && <DatalakeViewer />}
          </div>

          {/* RIGHT COLUMN — Agent Chat (oculto em paginas largas) */}
          {!isWidePage && (
            <div className="w-[400px] xl:w-[440px] shrink-0 h-full flex flex-col p-3 pl-0"
              style={{ borderLeft: `1px solid var(--ao-border)` }}>
              <AgentChat lastMessage={lastMessage} />
            </div>
          )}

          {/* Floating Assistant — aparece em paginas largas */}
          {isWidePage && (
            <>
              <button
                onClick={() => setChatOpen(v => !v)}
                className="fixed bottom-6 right-6 z-40 rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-105"
                style={{
                  width: 52, height: 52,
                  background: 'linear-gradient(135deg, #C4956A 0%, #a07a52 100%)',
                  color: '#fff',
                  boxShadow: '0 6px 20px rgba(196,149,106,0.4)',
                }}
                aria-label="Assistente"
              >
                {chatOpen ? <XIcon size={22} strokeWidth={2.4}/> : <MessageCircle size={22} strokeWidth={2.2}/>}
              </button>
              {chatOpen && (
                <div className="fixed bottom-24 right-6 z-40 rounded-2xl overflow-hidden flex flex-col"
                  style={{
                    width: 380, height: 'min(600px, 75vh)',
                    background: 'var(--ao-card)',
                    border: '1px solid var(--ao-border)',
                    boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
                  }}>
                  <AgentChat lastMessage={lastMessage} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <GlobalSearch isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
      <StatusBar />

      {/* Chat Panel overlay when agent is selected */}
      {selectedAgent && (
        <div className="w-[420px] shrink-0 h-full" style={{ borderLeft: `1px solid var(--ao-border)` }}>
          <ChatPanel agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
        </div>
      )}

      {/* Report Modal */}
      {(reportData || reportError || reportLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
          <div className="relative w-full max-w-[560px] max-h-[80vh] flex flex-col rounded-2xl overflow-hidden" style={{
            background: 'var(--ao-card)',
            border: '1px solid var(--ao-border)',
            boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
          }}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--ao-border)' }}>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{
                  background: 'linear-gradient(135deg, #C4956A 0%, #A67B52 100%)',
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10,9 9,9 8,9"/>
                  </svg>
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold" style={{ color: 'var(--ao-text)' }}>Relatorio Diario</h3>
                  <span className="text-[11px]" style={{ color: 'var(--ao-text-dim)' }}>
                    {new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
                  </span>
                </div>
              </div>
              <button
                onClick={() => { setReportData(null); setReportError(''); }}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer"
                style={{ background: 'var(--ao-input-bg)', color: 'var(--ao-text-muted)' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {reportLoading && (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--ao-border)', borderTopColor: 'transparent' }} />
                  <span className="text-[12px]" style={{ color: 'var(--ao-text-dim)' }}>Gerando relatorio...</span>
                </div>
              )}
              {reportError && (
                <div className="rounded-xl p-4" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <p className="text-[13px]" style={{ color: '#ef4444' }}>{reportError}</p>
                </div>
              )}
              {reportData && (
                <div className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--ao-text-secondary)', fontFamily: 'Space Grotesk, system-ui' }}>
                  {reportData}
                </div>
              )}
            </div>

            {/* Footer */}
            {reportData && (
              <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderTop: '1px solid var(--ao-border)' }}>
                <span className="text-[10px]" style={{ color: 'var(--ao-text-xs)' }}>Enviado via Telegram</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(reportData); }}
                  className="text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                  style={{ background: 'var(--ao-input-bg)', color: 'var(--ao-text-muted)', border: '1px solid var(--ao-border)' }}
                >
                  Copiar
                </button>
              </div>
            )}
          </div>
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
