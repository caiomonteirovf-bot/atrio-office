import { useState, useEffect, useCallback, useRef } from 'react'

// ─── Design tokens ───────────────────────────────────────────
const gold = '#C4956A'
const AGENT_COLORS = {
  Rodrigo: '#C4956A', Campelo: '#378ADD', Sneijder: '#639922', Luna: '#BA7517',
  Saldanha: '#7F77DD', Natalia: '#E05A33', Maia: '#D946A8', Dara: '#8B6F5A',
  // legacy
  Sofia: '#7F77DD', Valencia: '#E05A33',
}

const CATEGORY_META = {
  fiscal_rule: { label: 'Fiscal', color: '#378ADD', bg: '#378ADD15' },
  fiscal: { label: 'Fiscal', color: '#378ADD', bg: '#378ADD15' },
  financeiro: { label: 'Financeiro', color: '#639922', bg: '#63992215' },
  societario: { label: 'Societário', color: '#7F77DD', bg: '#7F77DD15' },
  atendimento: { label: 'Atendimento', color: '#BA7517', bg: '#BA751715' },
  comercial: { label: 'Comercial', color: '#E05A33', bg: '#E05A3315' },
  marketing: { label: 'Marketing', color: '#D946A8', bg: '#D946A815' },
  tecnologia: { label: 'Tecnologia', color: '#00B4D8', bg: '#00B4D815' },
  correction: { label: 'Correção', color: '#f87171', bg: '#f8717115' },
  preference: { label: 'Preferência', color: '#fbbf24', bg: '#fbbf2415' },
  process_rule: { label: 'Processo', color: '#60a5fa', bg: '#60a5fa15' },
  general: { label: 'Geral', color: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.05)' },
  client_fact: { label: 'Cliente', color: '#22c55e', bg: '#22c55e15' },
  learned_pattern: { label: 'Padrão', color: '#a78bfa', bg: '#a78bfa15' },
  tool_result: { label: 'Tool', color: '#f472b6', bg: '#f472b615' },
  workflow_tip: { label: 'Dica', color: '#fbbf24', bg: '#fbbf2415' },
  pessoal: { label: 'Pessoal', color: '#fb923c', bg: '#fb923c15' },
}

const CATEGORY_OPTIONS = [
  'fiscal', 'financeiro', 'societario', 'atendimento', 'comercial',
  'marketing', 'tecnologia', 'correction', 'preference', 'process_rule', 'general',
]

const formatDate = (d) => {
  if (!d) return '--'
  const date = new Date(d)
  const now = new Date()
  const diff = now - date
  if (diff < 60000) return 'agora'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}min`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}
const formatDateFull = (d) => d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'
const formatDateGroup = (d) => {
  if (!d) return ''
  const date = new Date(d)
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Hoje'
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem'
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

function CategoryPill({ category, size = 'sm' }) {
  const meta = CATEGORY_META[category] || CATEGORY_META.general
  const fontSize = size === 'sm' ? 10 : 11
  return (
    <span style={{
      padding: size === 'sm' ? '1px 7px' : '2px 10px', borderRadius: 4, fontSize, fontWeight: 600,
      background: meta.bg, color: meta.color, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

function AgentDot({ name, size = 8 }) {
  const color = AGENT_COLORS[name] || gold
  return <span style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
}

function AgentAvatar({ name, size = 28 }) {
  const color = AGENT_COLORS[name] || gold
  const letter = name === 'Saldanha' ? 'Sa' : (name?.[0] || '?')
  return (
    <div style={{
      width: size, height: size, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `${color}18`, color, fontSize: letter.length > 1 ? size * 0.32 : size * 0.42, fontWeight: 700, flexShrink: 0,
    }}>
      {letter}
    </div>
  )
}

function ConfidenceBar({ value = 100, width = 48 }) {
  const pct = Math.min(100, Math.max(0, value))
  const color = pct >= 80 ? gold : pct >= 50 ? `${gold}99` : 'rgba(255,255,255,0.25)'
  return (
    <div style={{ width, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }}>
      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: color, transition: 'width 0.3s' }} />
    </div>
  )
}

// ─── MAIN ─────────────────────────────────────────────────────
const MEMORY_TABS = [
  { id: 'todos',       label: 'Todos',             icon: 'TD' },
  { id: 'fatos',       label: 'Fatos de Cliente',  icon: 'FC', category: 'client_fact' },
  { id: 'transacoes',  label: 'Transacoes',        icon: 'TR', category: 'tool_result' },
  { id: 'alertas',     label: 'Alertas',           icon: '!',  entity_type: 'alerta_sentimento' },
  { id: 'regras',      label: 'Regras',            icon: 'RG', categories: 'fiscal_rule,process_rule,workflow_tip' },
  { id: 'aprendizados',label: 'Aprendizados',      icon: 'AP', categories: 'learned_pattern,correction' },
];

export default function HybridMemory() {
  const [view, setView] = useState('knowledge')
  const [stats, setStats] = useState(null)
  const [agents, setAgents] = useState([])
  const [clients, setClients] = useState([])
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [selectedClient, setSelectedClient] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTab, setSelectedTab] = useState('todos')
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => setAgents(Array.isArray(d) ? d : d.agents || []))
    fetch('/api/memory/clients-with-memories').then(r => r.json()).then(d => setClients(Array.isArray(d) ? d : [])).catch(() => setClients([]))
    refreshStats()
  }, [])

  const refreshStats = () => fetch('/api/memory/stats').then(r => r.json()).then(setStats).catch(() => {})
  const pendingCount = stats?.suggestions?.pending || 0
  const totalActive = stats?.memories?.approved || 0
  const totalAll = stats?.memories?.total || 0
  const ragEnabled = stats?.memories?.rag_enabled || 0

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 100px)', overflow: 'hidden' }}>
      {/* ── LEFT SIDEBAR ── */}
      <aside style={{
        width: 220, flexShrink: 0, padding: '20px 0', borderRight: '1px solid var(--ao-border)',
        display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto',
      }}>
        {/* Search */}
        <div style={{ padding: '0 14px', marginBottom: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8,
            background: 'var(--ao-input-bg)', border: '1px solid var(--ao-input-border)',
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ao-text-dim)" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar..." style={{
                border: 'none', background: 'transparent', color: 'var(--ao-text-primary)',
                fontSize: 12, outline: 'none', width: '100%',
              }} />
          </div>
        </div>

        {/* Main nav */}
        <SidebarSection label="VISÕES">
          <SidebarItem active={view === 'knowledge'} onClick={() => setView('knowledge')}
            icon={<IconBrain />} label="Conhecimento" count={totalActive} />
          <SidebarItem active={view === 'review'} onClick={() => setView('review')}
            icon={<IconInbox />} label="Revisar" count={pendingCount}
            badge={pendingCount > 0} />
          <SidebarItem active={view === 'history'} onClick={() => setView('history')}
            icon={<IconClock />} label="Histórico" />
        </SidebarSection>

        <div style={{ height: 1, background: 'var(--ao-border)', margin: '8px 14px' }} />

        {/* Agent filters */}
        <SidebarSection label="AGENTES">
          <SidebarItem active={selectedAgent === null} onClick={() => setSelectedAgent(null)}
            icon={<span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ao-text-dim)' }} />}
            label="Todos" />
          {agents.map(a => (
            <SidebarItem key={a.id} active={selectedAgent === a.id}
              onClick={() => setSelectedAgent(selectedAgent === a.id ? null : a.id)}
              icon={<AgentDot name={a.name} />} label={a.name} />
          ))}
        </SidebarSection>

        <div style={{ height: 1, background: 'var(--ao-border)', margin: '8px 14px' }} />

        {/* Client filters */}
        <SidebarSection label={`CLIENTES${clients.length ? ` (${clients.length})` : ''}`}>
          <SidebarItem active={selectedClient === null} onClick={() => setSelectedClient(null)}
            icon={<span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--ao-text-dim)' }} />}
            label="Todos" />
          {clients.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', padding: '4px 20px' }}>
              Nenhuma memoria por cliente ainda
            </div>
          ) : clients.map(c => (
            <SidebarItem key={c.id} active={selectedClient === c.id}
              onClick={() => setSelectedClient(selectedClient === c.id ? null : c.id)}
              icon={<span style={{ width: 8, height: 8, borderRadius: '50%', background: c.rag_enabled > 0 ? '#22c55e' : 'var(--ao-text-dim)' }} />}
              label={c.nome} count={c.total} />
          ))}
        </SidebarSection>

        <div style={{ height: 1, background: 'var(--ao-border)', margin: '8px 14px' }} />

        {/* Category filters */}
        <SidebarSection label="CATEGORIAS">
          <SidebarItem active={selectedCategory === null} onClick={() => setSelectedCategory(null)}
            label="Todas" icon={<span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--ao-text-dim)' }} />} />
          {CATEGORY_OPTIONS.map(cat => {
            const meta = CATEGORY_META[cat] || CATEGORY_META.general
            return (
              <SidebarItem key={cat} active={selectedCategory === cat}
                onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                icon={<span style={{ width: 8, height: 8, borderRadius: 2, background: meta.color }} />}
                label={meta.label} />
            )
          })}
        </SidebarSection>

        {/* Bottom spacer + Teach button */}
        <div style={{ flex: 1 }} />
        <div style={{ padding: '12px 14px' }}>
          <button onClick={() => setShowCreate(true)} style={{
            width: '100%', padding: '9px 0', borderRadius: 8,
            border: '1px solid rgba(196,149,106,0.25)', background: 'rgba(196,149,106,0.08)',
            color: gold, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            transition: 'all 0.15s',
          }}>
            <span style={{ fontSize: 15, fontWeight: 400 }}>+</span> Ensinar
          </button>
        </div>
      </aside>

      {/* ── MAIN CONTENT ── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header bar */}
        <div style={{
          padding: '14px 24px', borderBottom: '1px solid var(--ao-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--ao-text-primary)', margin: 0, flexShrink: 0 }}>
              {view === 'knowledge' ? 'Conhecimento' : view === 'review' ? 'Sugestões' : 'Histórico'}
            </h2>
            {view === 'knowledge' && (
              <div style={{ display: 'flex', gap: 4, overflowX: 'auto', flex: 1 }}>
                {MEMORY_TABS.map(t => {
                  const active = selectedTab === t.id;
                  return (
                    <button key={t.id} onClick={() => setSelectedTab(t.id)} style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                      background: active ? 'var(--ao-accent-muted)' : 'transparent',
                      color: active ? 'var(--ao-accent)' : 'var(--ao-text-secondary)',
                      fontSize: 12, fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
                      display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.15s',
                    }}>
                      <span style={{ fontSize: 11, opacity: 0.7, fontFamily: "'Space Grotesk', monospace" }}>{t.icon}</span>
                      <span>{t.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <MiniStat label="Ativos" value={totalActive} color="#22c55e" />
            <MiniStat label="RAG" value={ragEnabled} color={gold} />
            <MiniStat label="Pendentes" value={pendingCount} color={pendingCount > 0 ? '#fbbf24' : 'var(--ao-text-dim)'} />
            <MiniStat label="Total" value={totalAll} color="var(--ao-text-secondary)" />
          </div>
        </div>

        {/* Content area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
          {view === 'knowledge' && (
            <KnowledgeView agents={agents} clients={clients}
              selectedAgent={selectedAgent} selectedClient={selectedClient} selectedCategory={selectedCategory}
              selectedTab={selectedTab}
              searchQuery={searchQuery} onRefresh={refreshStats} />
          )}
          {view === 'review' && (
            <ReviewView agents={agents} onAction={refreshStats} />
          )}
          {view === 'history' && <HistoryView />}
        </div>
      </main>

      {/* ── CREATE MODAL ── */}
      {showCreate && (
        <CreateModal agents={agents} onClose={() => setShowCreate(false)}
          onCreated={() => { refreshStats(); setShowCreate(false) }} />
      )}
    </div>
  )
}

// ─── Sidebar components ──────────────────────────────────────
function SidebarSection({ label, children }) {
  return (
    <div>
      <div style={{ padding: '8px 14px 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', color: 'var(--ao-text-xs)', textTransform: 'uppercase' }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function SidebarItem({ active, onClick, icon, label, count, badge }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 14px',
      border: 'none', borderRadius: 0, cursor: 'pointer', fontSize: 12, fontWeight: 500,
      background: active ? 'rgba(196,149,106,0.08)' : 'transparent',
      color: active ? 'var(--ao-text-primary)' : 'var(--ao-text-secondary)',
      borderLeft: active ? `2px solid ${gold}` : '2px solid transparent',
      transition: 'all 0.1s',
    }}>
      {icon}
      <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      {count > 0 && (
        <span style={{
          fontSize: 10, fontWeight: 600, minWidth: 18, textAlign: 'center',
          padding: '1px 5px', borderRadius: 10,
          ...(badge ? { background: 'rgba(251,191,36,0.2)', color: '#fbbf24' }
            : { color: 'var(--ao-text-dim)' }),
        }}>
          {count}
        </span>
      )}
    </button>
  )
}

function MiniStat({ label, value, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontFamily: "'Outfit', sans-serif" }}>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</span>
    </div>
  )
}

// ─── SVG Icons ───────────────────────────────────────────────
function IconBrain() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4v1a3 3 0 0 1 3 3v1a3 3 0 0 1-1 2.2V16a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4v-2.8A3 3 0 0 1 5 11v-1a3 3 0 0 1 3-3V6a4 4 0 0 1 4-4z"/></svg>
}
function IconInbox() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
}
function IconClock() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
}

// ─── KNOWLEDGE VIEW ──────────────────────────────────────────
function KnowledgeView({ agents, clients = [], selectedAgent, selectedClient, selectedCategory, selectedTab = 'todos', searchQuery, onRefresh }) {
  const tabSpec = MEMORY_TABS.find(t => t.id === selectedTab) || MEMORY_TABS[0];
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedMem, setSelectedMem] = useState(null)

  const fetchMemories = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: 'approved', limit: '200' })
      if (selectedAgent) params.set('agent_id', selectedAgent)
      if (selectedClient) params.set('client_id', selectedClient)
      if (selectedCategory) params.set('category', selectedCategory)
      if (!selectedCategory && tabSpec) {
        if (tabSpec.category) params.set('category', tabSpec.category)
        if (tabSpec.categories) params.set('categories', tabSpec.categories)
        if (tabSpec.entity_type) params.set('entity_type', tabSpec.entity_type)
        if (tabSpec.source_type) params.set('source_type', tabSpec.source_type)
      }
      const res = await fetch(`/api/memory?${params}`)
      const data = await res.json()
      setMemories(data.memories || [])
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [selectedAgent, selectedClient, selectedCategory, selectedTab])

  useEffect(() => { fetchMemories() }, [fetchMemories])

  const filtered = memories.filter(m => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (m.title || '').toLowerCase().includes(q) || (m.content || '').toLowerCase().includes(q) || (m.summary || '').toLowerCase().includes(q)
  })

  const handleToggleRag = async (mem) => {
    const endpoint = mem.is_rag_enabled ? 'disable-rag' : 'enable-rag'
    await fetch(`/api/memory/${mem.id}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    fetchMemories()
    onRefresh?.()
  }

  const handleArchive = async (mem) => {
    if (!confirm('Arquivar este conhecimento?')) return
    await fetch(`/api/memory/${mem.id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    setSelectedMem(null)
    fetchMemories()
    onRefresh?.()
  }

  if (loading) return <LoadingState />
  if (filtered.length === 0) return <EmptyState icon="🧠" title="Nenhum conhecimento encontrado" sub="Ensine algo novo para a equipe usando o botão abaixo" />

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Column headers */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 90px 60px 50px 50px',
          padding: '8px 24px', fontSize: 10, fontWeight: 600, color: 'var(--ao-text-xs)',
          textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--ao-border)',
          position: 'sticky', top: 0, background: 'var(--ao-surface)', zIndex: 1,
        }}>
          <span>Conhecimento</span>
          <span>Categoria</span>
          <span>Confiança</span>
          <span style={{ textAlign: 'center' }}>RAG</span>
          <span style={{ textAlign: 'right' }}>Usado</span>
        </div>

        {filtered.map(mem => {
          const isSelected = selectedMem?.id === mem.id
          return (
            <div key={mem.id} onClick={() => setSelectedMem(isSelected ? null : mem)} style={{
              display: 'grid', gridTemplateColumns: '1fr 90px 60px 50px 50px',
              padding: '10px 24px', cursor: 'pointer',
              borderBottom: '1px solid var(--ao-border)',
              background: isSelected ? 'rgba(196,149,106,0.06)' : 'transparent',
              borderLeft: isSelected ? `2px solid ${gold}` : '2px solid transparent',
              transition: 'all 0.1s',
            }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.02)' }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}>
              {/* Title + agent */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <AgentDot name={mem.agent_name} size={7} />
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ao-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {mem.title}
                </span>
              </div>

              {/* Category */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <CategoryPill category={mem.category} />
              </div>

              {/* Confidence */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <ConfidenceBar value={mem.confidence_score ? mem.confidence_score * 100 : 100} />
              </div>

              {/* RAG status */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {mem.is_rag_enabled ? (
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.4)' }} />
                ) : (
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'rgba(255,255,255,0.12)' }} />
                )}
              </div>

              {/* Use count */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 11, color: 'var(--ao-text-dim)', fontFamily: "'Space Grotesk', monospace" }}>
                  {mem.use_count || 0}×
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Detail panel (slide-in) */}
      {selectedMem && (
        <DetailPanel mem={selectedMem} onClose={() => setSelectedMem(null)}
          onToggleRag={() => handleToggleRag(selectedMem)}
          onArchive={() => handleArchive(selectedMem)} />
      )}
    </div>
  )
}

// ─── DETAIL PANEL ────────────────────────────────────────────
function DetailPanel({ mem, onClose, onToggleRag, onArchive }) {
  const meta = CATEGORY_META[mem.category] || CATEGORY_META.general
  return (
    <div style={{
      width: 340, borderLeft: '1px solid var(--ao-border)', padding: '20px',
      overflowY: 'auto', flexShrink: 0, background: 'var(--ao-surface)',
      animation: 'slideIn 0.15s ease-out',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <AgentAvatar name={mem.agent_name} size={32} />
        <button onClick={onClose} style={{
          border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ao-text-dim)',
          padding: 4, borderRadius: 4, fontSize: 16, lineHeight: 1,
        }}>×</button>
      </div>

      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--ao-text-primary)', margin: '0 0 8px', lineHeight: 1.4 }}>
        {mem.title}
      </h3>

      {/* Meta row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <CategoryPill category={mem.category} size="md" />
        <span style={{ fontSize: 11, color: 'var(--ao-text-dim)' }}>{mem.agent_name}</span>
        <span style={{ fontSize: 11, color: 'var(--ao-text-xs)' }}>·</span>
        <span style={{ fontSize: 11, color: 'var(--ao-text-xs)' }}>{formatDateFull(mem.created_at)}</span>
      </div>

      {/* Summary */}
      {mem.summary && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, marginBottom: 16,
          background: `${meta.color}08`, borderLeft: `3px solid ${meta.color}40`,
          fontSize: 12, color: 'var(--ao-text-secondary)', lineHeight: 1.5, fontStyle: 'italic',
        }}>
          {mem.summary}
        </div>
      )}

      {/* Content */}
      <div style={{
        fontSize: 13, color: 'var(--ao-text-secondary)', lineHeight: 1.7, whiteSpace: 'pre-wrap',
        padding: '14px', borderRadius: 8, background: 'var(--ao-input-bg)',
        border: '1px solid var(--ao-border)', marginBottom: 16,
      }}>
        {mem.content}
      </div>

      {/* Stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16,
      }}>
        {[
          { label: 'Usado', value: `${mem.use_count || 0}×` },
          { label: 'Confiança', value: `${mem.confidence_score ? Math.round(mem.confidence_score * 100) : 100}%` },
          { label: 'Criado via', value: mem.source_type === 'manual' ? 'Manual' : 'Auto' },
        ].map((s, i) => (
          <div key={i} style={{ textAlign: 'center', padding: '8px 4px', borderRadius: 6, background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ao-text-primary)', fontFamily: "'Outfit', sans-serif" }}>{s.value}</div>
            <div style={{ fontSize: 10, color: 'var(--ao-text-xs)', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onToggleRag} style={{
          flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid',
          fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
          ...(mem.is_rag_enabled
            ? { borderColor: 'rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.08)', color: '#22c55e' }
            : { borderColor: 'var(--ao-border)', background: 'transparent', color: 'var(--ao-text-secondary)' }),
        }}>
          {mem.is_rag_enabled ? '● RAG ativo' : '○ Ativar RAG'}
        </button>
        <button onClick={onArchive} style={{
          padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(248,113,113,0.2)',
          background: 'transparent', color: '#f87171', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>
          Arquivar
        </button>
      </div>
    </div>
  )
}

// ─── REVIEW VIEW ─────────────────────────────────────────────
function ReviewView({ agents, onAction }) {
  const [suggestions, setSuggestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('pending')
  const [expandedId, setExpandedId] = useState(null)
  const [reviewNotes, setReviewNotes] = useState('')

  const fetchSuggestions = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ status: filterStatus, limit: '50' })
      const res = await fetch(`/api/memory/suggestions?${params}`)
      const data = await res.json()
      setSuggestions(data.suggestions || [])
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [filterStatus])

  useEffect(() => { fetchSuggestions() }, [fetchSuggestions])

  const handleAction = async (id, action) => {
    await fetch(`/api/memory/suggestions/${id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_notes: reviewNotes }),
    })
    setExpandedId(null)
    setReviewNotes('')
    fetchSuggestions()
    onAction?.()
  }

  // Auto-run triggers
  const [triggersRan, setTriggersRan] = useState(false)
  useEffect(() => {
    if (!loading && suggestions.length === 0 && filterStatus === 'pending' && !triggersRan) {
      setTriggersRan(true)
      fetch('/api/memory/triggers/run', { method: 'POST' })
        .then(r => r.json())
        .then(data => { if (data.total > 0) fetchSuggestions() })
        .catch(() => {})
    }
  }, [loading, suggestions.length, filterStatus, triggersRan])

  return (
    <div style={{ padding: '0 24px' }}>
      {/* Status filter tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--ao-border)', paddingTop: 12 }}>
        {[
          { id: 'pending', label: 'Pendentes', color: '#fbbf24' },
          { id: 'approved', label: 'Aprovadas', color: '#22c55e' },
          { id: 'rejected', label: 'Rejeitadas', color: '#f87171' },
        ].map(f => (
          <button key={f.id} onClick={() => setFilterStatus(f.id)} style={{
            padding: '10px 20px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: 'transparent',
            color: filterStatus === f.id ? f.color : 'var(--ao-text-dim)',
            borderBottom: filterStatus === f.id ? `2px solid ${f.color}` : '2px solid transparent',
            transition: 'all 0.15s',
          }}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? <LoadingState /> : suggestions.length === 0 ? (
        <EmptyState icon="✓" title={filterStatus === 'pending' ? 'Nada para revisar' : `Nenhuma sugestão ${filterStatus === 'approved' ? 'aprovada' : 'rejeitada'}`}
          sub="As sugestões aparecem quando agentes detectam padrões recorrentes" />
      ) : (
        <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {suggestions.map(s => {
            const isOpen = expandedId === s.id
            return (
              <div key={s.id} style={{
                borderRadius: 10, overflow: 'hidden',
                border: `1px solid ${isOpen ? 'rgba(196,149,106,0.15)' : 'var(--ao-border)'}`,
                background: isOpen ? 'rgba(196,149,106,0.03)' : 'transparent',
                transition: 'all 0.15s',
              }}>
                {/* Header row */}
                <div onClick={() => setExpandedId(isOpen ? null : s.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer',
                }}>
                  <AgentAvatar name={s.agent_name} size={28} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ao-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title || s.proposed_content?.substring(0, 60)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', marginTop: 2 }}>
                      {s.agent_name} · {formatDate(s.created_at)}
                      {s.trigger_type && <span> · via {s.trigger_type.replace('_', ' ')}</span>}
                    </div>
                  </div>

                  {/* Quick actions (only if pending + collapsed) */}
                  {s.review_status === 'pending' && !isOpen && (
                    <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                      <ActionBtn color="#22c55e" onClick={() => handleAction(s.id, 'approve')}>✓</ActionBtn>
                      <ActionBtn color="#f87171" onClick={() => handleAction(s.id, 'reject')}>×</ActionBtn>
                    </div>
                  )}
                </div>

                {/* Expanded content */}
                {isOpen && (
                  <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--ao-border)' }}>
                    {s.reason && (
                      <div style={{
                        fontSize: 12, color: 'var(--ao-text-muted)', margin: '12px 0',
                        padding: '8px 12px', borderRadius: 6, background: 'var(--ao-input-bg)',
                        borderLeft: `3px solid ${gold}40`,
                      }}>
                        <strong style={{ color: 'var(--ao-text-secondary)' }}>Motivo:</strong> {s.reason}
                      </div>
                    )}

                    <div style={{
                      fontSize: 13, color: 'var(--ao-text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                      background: 'var(--ao-input-bg)', padding: 14, borderRadius: 8, margin: '8px 0 12px',
                      border: '1px solid var(--ao-border)',
                    }}>
                      {s.proposed_content}
                    </div>

                    {s.review_status === 'pending' && (
                      <div onClick={e => e.stopPropagation()}>
                        <input value={reviewNotes} onChange={e => setReviewNotes(e.target.value)}
                          placeholder="Observação (opcional)..." style={{
                            width: '100%', padding: '8px 12px', borderRadius: 6, boxSizing: 'border-box',
                            background: 'var(--ao-input-bg)', border: '1px solid var(--ao-input-border)',
                            color: 'var(--ao-text-primary)', fontSize: 12, outline: 'none', marginBottom: 10,
                          }} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => handleAction(s.id, 'approve')} style={{
                            padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(34,197,94,0.3)',
                            background: 'rgba(34,197,94,0.08)', color: '#22c55e', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          }}>Aprovar</button>
                          <button onClick={() => handleAction(s.id, 'reject')} style={{
                            padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(248,113,113,0.3)',
                            background: 'rgba(248,113,113,0.08)', color: '#f87171', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          }}>Rejeitar</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ActionBtn({ color, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      width: 28, height: 28, borderRadius: 6, border: `1px solid ${color}30`,
      background: `${color}10`, color, fontSize: 14, fontWeight: 700,
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'all 0.1s',
    }}>
      {children}
    </button>
  )
}

// ─── HISTORY VIEW ────────────────────────────────────────────
const ACTION_META = {
  created: { label: 'Criou', color: '#60a5fa', icon: '+' },
  updated: { label: 'Editou', color: '#fbbf24', icon: '✎' },
  approved: { label: 'Aprovou', color: '#22c55e', icon: '✓' },
  rejected: { label: 'Rejeitou', color: '#f87171', icon: '×' },
  archived: { label: 'Arquivou', color: 'var(--ao-text-dim)', icon: '⊘' },
  rag_enabled: { label: 'Ativou RAG', color: '#22c55e', icon: '●' },
  rag_disabled: { label: 'Desativou RAG', color: '#f87171', icon: '○' },
  edit_and_approved: { label: 'Editou e aprovou', color: '#22c55e', icon: '✓' },
  merged: { label: 'Mesclou', color: '#60a5fa', icon: '⊕' },
  superseded: { label: 'Substituiu', color: 'var(--ao-text-xs)', icon: '↺' },
  auto_extracted: { label: 'Extraído', color: '#a78bfa', icon: '✨' },
  consolidated: { label: 'Consolidou', color: '#60a5fa', icon: '⊙' },
  decayed: { label: 'Expirou', color: 'var(--ao-text-xs)', icon: '⌛' },
}

function HistoryView() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/memory/audit?limit=100')
      .then(r => r.json())
      .then(data => {
        const arr = Array.isArray(data) ? data : (data?.audit || [])
        setLogs(arr); setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const getTitle = (log) => {
    if (log.memory_title) return log.memory_title
    const data = log.after_json || log.before_json
    if (!data) return null
    const parsed = typeof data === 'string' ? (() => { try { return JSON.parse(data) } catch { return null } })() : data
    return parsed?.title || parsed?.proposed_content?.substring(0, 80) || null
  }
  const getDetails = (log) => {
    const data = log.after_json
    if (!data) return null
    const parsed = typeof data === 'string' ? (() => { try { return JSON.parse(data) } catch { return null } })() : data
    if (!parsed) return null
    const bits = []
    if (parsed.tool) bits.push(parsed.tool)
    if (parsed.category) bits.push(parsed.category)
    if (parsed.confidence != null) bits.push(`conf ${Math.round(parsed.confidence * 100)}%`)
    return bits.length ? bits.join(' · ') : null
  }

  // Group by date
  const grouped = {}
  logs.forEach(log => {
    const key = formatDateGroup(log.created_at)
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(log)
  })

  if (loading) return <LoadingState />
  if (logs.length === 0) return <EmptyState icon="📋" title="Nenhuma ação registrada" sub="O histórico aparece quando conhecimentos são criados, editados ou revisados" />

  return (
    <div style={{ padding: '16px 24px' }}>
      {Object.entries(grouped).map(([dateLabel, groupLogs]) => (
        <div key={dateLabel} style={{ marginBottom: 24 }}>
          {/* Date header */}
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--ao-text-dim)', marginBottom: 8,
            padding: '4px 0', borderBottom: '1px solid var(--ao-border)',
            textTransform: 'uppercase', letterSpacing: '0.3px',
          }}>
            {dateLabel}
          </div>

          {/* Timeline */}
          <div style={{ position: 'relative', paddingLeft: 24 }}>
            {/* Vertical line */}
            <div style={{
              position: 'absolute', left: 7, top: 4, bottom: 4, width: 1,
              background: 'var(--ao-border)',
            }} />

            {groupLogs.map(log => {
              const meta = ACTION_META[log.action] || { label: log.action, color: 'var(--ao-text-dim)', icon: '·' }
              const title = getTitle(log)
              return (
                <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', position: 'relative' }}>
                  {/* Dot */}
                  <div style={{
                    position: 'absolute', left: -20, width: 15, height: 15, borderRadius: '50%',
                    background: 'var(--ao-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: `1.5px solid ${meta.color}`, fontSize: 8, color: meta.color,
                  }}>
                    {meta.icon}
                  </div>

                  {/* Time */}
                  <span style={{
                    fontSize: 11, color: 'var(--ao-text-xs)', fontFamily: "'Space Grotesk', monospace",
                    minWidth: 40, flexShrink: 0,
                  }}>
                    {new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </span>

                  {/* Action */}
                  <span style={{ fontSize: 12, fontWeight: 600, color: meta.color, minWidth: 80, flexShrink: 0 }}>
                    {meta.label}
                  </span>

                  {/* Title */}
                  <span style={{
                    fontSize: 12, color: 'var(--ao-text-secondary)', flex: 1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {title || log.entity_id?.substring(0, 8)}
                  </span>

                  {/* Details */}
                  {getDetails(log) && (
                    <span style={{
                      fontSize: 10, color: 'var(--ao-text-xs)', fontFamily: "'Space Grotesk', monospace",
                      padding: '2px 6px', background: 'var(--ao-surface-elevated)', borderRadius: 4, flexShrink: 0,
                    }}>
                      {getDetails(log)}
                    </span>
                  )}

                  {/* Client */}
                  {(() => {
                    const after = typeof log.after_json === 'string' ? (() => { try { return JSON.parse(log.after_json) } catch { return null } })() : log.after_json
                    const cn = log.client_name || after?.client_name
                    return cn ? (
                      <span style={{ fontSize: 10, color: 'var(--ao-text-xs)', flexShrink: 0, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {cn}
                      </span>
                    ) : null
                  })()}

                  {/* Actor */}
                  <span style={{ fontSize: 10, color: 'var(--ao-text-xs)', flexShrink: 0 }} title={log.actor_name || log.actor_type}>
                    {log.actor_type === 'human' ? '👤' : log.actor_type === 'system' ? '⚙' : '🤖'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── CREATE MODAL ────────────────────────────────────────────
function CreateModal({ agents, onClose, onCreated }) {
  const [form, setForm] = useState({
    agent_id: '', category: 'general', title: '', content: '', summary: '', scope_type: 'global', priority: 0,
  })
  const [saving, setSaving] = useState(false)
  const overlayRef = useRef(null)

  const handleSubmit = async () => {
    if (!form.title || !form.content) return
    setSaving(true)
    try {
      await fetch('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, status: 'approved' }),
      })
      onCreated?.()
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  return (
    <div ref={overlayRef} onClick={e => { if (e.target === overlayRef.current) onClose() }} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div style={{
        width: 520, maxHeight: '80vh', overflowY: 'auto', borderRadius: 16,
        background: 'var(--ao-card)', border: '1px solid var(--ao-border)', padding: 28,
        boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ao-text-primary)' }}>Ensinar Conhecimento</h3>
          <button onClick={onClose} style={{
            border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ao-text-dim)', fontSize: 18,
          }}>×</button>
        </div>

        {/* Agent selector */}
        <FormField label="Para quem?">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <ChipBtn active={!form.agent_id} onClick={() => setForm(f => ({ ...f, agent_id: '', scope_type: 'global' }))}
              color={gold}>Todos</ChipBtn>
            {agents.map(a => (
              <ChipBtn key={a.id} active={form.agent_id === a.id}
                onClick={() => setForm(f => ({ ...f, agent_id: a.id, scope_type: 'agent' }))}
                color={AGENT_COLORS[a.name] || gold}>{a.name}</ChipBtn>
            ))}
          </div>
        </FormField>

        {/* Category */}
        <FormField label="Categoria">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CATEGORY_OPTIONS.map(cat => {
              const meta = CATEGORY_META[cat] || CATEGORY_META.general
              return (
                <ChipBtn key={cat} active={form.category === cat}
                  onClick={() => setForm(f => ({ ...f, category: cat }))}
                  color={meta.color}>{meta.label}</ChipBtn>
              )
            })}
          </div>
        </FormField>

        {/* Title */}
        <FormField label="Título">
          <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Ex: Prazo do Simples Nacional" style={{
              width: '100%', padding: '10px 14px', borderRadius: 8, boxSizing: 'border-box',
              background: 'var(--ao-input-bg)', border: '1px solid var(--ao-input-border)',
              color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none',
            }} />
        </FormField>

        {/* Content */}
        <FormField label="O que o agente precisa saber?">
          <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} rows={5}
            placeholder="Escreva a informação que o agente deve lembrar..."
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 8, boxSizing: 'border-box', resize: 'vertical',
              background: 'var(--ao-input-bg)', border: '1px solid var(--ao-input-border)',
              color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none', lineHeight: 1.6,
            }} />
        </FormField>

        {/* Summary */}
        <FormField label="Resumo curto (opcional)">
          <input value={form.summary} onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
            placeholder="Uma frase que resume..." style={{
              width: '100%', padding: '10px 14px', borderRadius: 8, boxSizing: 'border-box',
              background: 'var(--ao-input-bg)', border: '1px solid var(--ao-input-border)',
              color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none',
            }} />
        </FormField>

        {/* Submit */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 8 }}>
          <button onClick={onClose} style={{
            padding: '10px 20px', borderRadius: 8, border: '1px solid var(--ao-border)',
            background: 'transparent', color: 'var(--ao-text-secondary)', fontSize: 13, cursor: 'pointer',
          }}>Cancelar</button>
          <button onClick={handleSubmit} disabled={!form.title || !form.content || saving} style={{
            padding: '10px 24px', borderRadius: 8, border: '1px solid rgba(196,149,106,0.3)',
            background: 'rgba(196,149,106,0.12)', color: gold, fontSize: 13, fontWeight: 600,
            cursor: (!form.title || !form.content || saving) ? 'not-allowed' : 'pointer',
            opacity: (!form.title || !form.content || saving) ? 0.5 : 1,
          }}>
            {saving ? 'Salvando...' : 'Ensinar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Shared UI components ────────────────────────────────────
function FormField({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-dim)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function ChipBtn({ active, onClick, color, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer',
      border: `1px solid ${active ? `${color}50` : 'var(--ao-border)'}`,
      background: active ? `${color}12` : 'transparent',
      color: active ? color : 'var(--ao-text-secondary)',
      transition: 'all 0.1s',
    }}>
      {children}
    </button>
  )
}

function LoadingState() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
      <div style={{ width: 24, height: 24, border: `2px solid ${gold}30`, borderTop: `2px solid ${gold}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } } @keyframes slideIn { from { transform: translateX(20px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }`}</style>
    </div>
  )
}

function EmptyState({ icon, title, sub }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 40px', textAlign: 'center' }}>
      <div style={{ fontSize: 36, marginBottom: 14, opacity: 0.4 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ao-text-secondary)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--ao-text-dim)', maxWidth: 300 }}>{sub}</div>
    </div>
  )
}
