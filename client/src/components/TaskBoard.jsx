import { useState, useEffect, useCallback } from 'react'
import { Clock, AlertTriangle, CheckCircle, Circle, Loader, XCircle, RotateCcw, ChevronDown, ChevronUp, User } from 'lucide-react'
import { api } from '../lib/api'

// ============================================
// CONFIG
// ============================================

const STATUS_CONFIG = {
  pending:     { label: 'Pendente',       icon: Circle,        color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.06)', border: 'rgba(245, 158, 11, 0.08)' },
  in_progress: { label: 'Em andamento',   icon: Loader,        color: '#378ADD', bg: 'rgba(55, 138, 221, 0.06)', border: 'rgba(55, 138, 221, 0.08)' },
  done:        { label: 'Concluida',      icon: CheckCircle,   color: '#639922', bg: 'rgba(99, 153, 34, 0.06)',  border: 'rgba(99, 153, 34, 0.08)' },
  blocked:     { label: 'Bloqueada',      icon: AlertTriangle, color: '#ef4444', bg: 'rgba(239, 68, 68, 0.06)',  border: 'rgba(239, 68, 68, 0.08)' },
  cancelled:   { label: 'Cancelada',      icon: XCircle,       color: '#6b7280', bg: 'rgba(107, 114, 128, 0.06)', border: 'rgba(107, 114, 128, 0.08)' },
}

const PRIORITY_CONFIG = {
  urgent: { label: 'Urgente', color: '#ef4444', pulse: true },
  high:   { label: 'Alta',    color: '#f97316', pulse: false },
  medium: { label: 'Media',   color: '#378ADD', pulse: false },
  low:    { label: 'Baixa',   color: '#6b7280', pulse: false },
}

const AGENT_COLORS = {
  'Rodrigo':  '#C4956A',
  'Campelo':  '#378ADD',
  'Sneijder': '#639922',
  'Luna':     '#BA7517',
  'Sofia':    '#7F77DD',
  'Valencia': '#E05A33',
  'Maia':     '#D946A8',
}

const FILTER_TABS = [
  { key: 'all',         label: 'Todas' },
  { key: 'pending',     label: 'Pendente' },
  { key: 'in_progress', label: 'Em andamento' },
  { key: 'blocked',     label: 'Bloqueada' },
  { key: 'done',        label: 'Concluida' },
  { key: 'cancelled',   label: 'Cancelada' },
]

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 }

// ============================================
// HELPERS
// ============================================

function timeSince(dateStr) {
  if (!dateStr) return ''
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `${Math.floor(s / 60)}min atras`
  if (s < 86400) return `${Math.floor(s / 3600)}h atras`
  const d = Math.floor(s / 86400)
  return d === 1 ? '1d atras' : `${d}d atras`
}

function getAgentColor(name) {
  if (!name) return '#6b7280'
  const firstName = name.split(' ')[0]
  return AGENT_COLORS[firstName] || '#C4956A'
}

// ============================================
// SUB-COMPONENTS
// ============================================

function AgentAvatar({ name }) {
  const color = getAgentColor(name)
  const letter = name ? name[0].toUpperCase() : '?'
  return (
    <div
      className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0"
      style={{
        background: `${color}12`,
        color: `${color}aa`,
        border: `1px solid ${color}18`,
      }}
    >
      {letter}
    </div>
  )
}

function PriorityDot({ priority }) {
  const cfg = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.medium
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${cfg.pulse ? 'animate-pulse' : ''}`}
      style={{ background: cfg.color, boxShadow: cfg.pulse ? `0 0 8px ${cfg.color}80` : 'none' }}
      title={cfg.label}
    />
  )
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  return (
    <span
      className="text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wider"
      style={{
        background: `${cfg.color}15`,
        color: cfg.color,
        border: `1px solid ${cfg.color}15`,
      }}
    >
      {cfg.label}
    </span>
  )
}

function FilterTabs({ active, counts, onChange }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-hide">
      {FILTER_TABS.map(tab => {
        const count = tab.key === 'all' ? counts.total : (counts[tab.key] || 0)
        const isActive = active === tab.key
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className="text-[10px] font-medium px-2.5 py-1 rounded-lg whitespace-nowrap transition-all"
            style={{
              background: isActive ? 'rgba(196, 149, 106, 0.1)' : 'transparent',
              color: isActive ? '#C4956A' : 'var(--ao-text-dim)',
              border: `1px solid ${isActive ? 'rgba(196, 149, 106, 0.15)' : 'transparent'}`,
            }}
          >
            {tab.label}
            {count > 0 && (
              <span
                className="ml-1 text-[9px] tabular-nums"
                style={{ fontFamily: 'Space Grotesk', opacity: isActive ? 1 : 0.6 }}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function EmptyState({ filter }) {
  const messages = {
    all:         { title: 'Nenhuma tarefa no momento', sub: 'As tarefas delegadas pelos agentes aparecerao aqui' },
    pending:     { title: 'Nenhuma tarefa pendente', sub: 'Tarefas novas aparecerao aqui quando criadas' },
    in_progress: { title: 'Nenhuma tarefa em andamento', sub: 'Tarefas sendo executadas aparecerao aqui' },
    blocked:     { title: 'Nenhuma tarefa bloqueada', sub: 'Otimo! Nenhum impedimento no momento' },
    done:        { title: 'Nenhuma tarefa concluida', sub: 'Tarefas finalizadas aparecerao aqui' },
    cancelled:   { title: 'Nenhuma tarefa cancelada', sub: 'Tarefas canceladas aparecerao aqui' },
  }
  const msg = messages[filter] || messages.all
  return (
    <div className="glass-card rounded-xl p-6 text-center">
      <div
        className="w-10 h-10 rounded-xl mx-auto mb-2.5 flex items-center justify-center"
        style={{ background: 'rgba(196, 149, 106, 0.06)', border: '1px solid rgba(196, 149, 106, 0.06)' }}
      >
        <ClipboardList size={18} color="rgba(196, 149, 106, 0.4)" />
      </div>
      <p className="text-[12px] font-medium" style={{ color: 'var(--ao-text-dim)' }}>{msg.title}</p>
      <p className="text-[10px] mt-1" style={{ color: 'var(--ao-text-xs)' }}>{msg.sub}</p>
    </div>
  )
}

function TaskCard({ task, expanded, onToggle, onAction, actionLoading }) {
  const statusCfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending
  const StatusIcon = statusCfg.icon
  const priorityCfg = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium
  const isDone = task.status === 'done' || task.status === 'cancelled'

  return (
    <div
      className="glass-card rounded-xl overflow-hidden transition-all stagger-item"
      style={{
        borderLeft: `2px solid ${priorityCfg.color}${priorityCfg.pulse ? '' : '60'}`,
        opacity: isDone ? 0.65 : 1,
      }}
    >
      {/* Header — always visible, clickable */}
      <button
        onClick={onToggle}
        className="w-full text-left p-3.5 flex items-start gap-3 hover:bg-white/[0.02] transition-colors"
      >
        {/* Priority dot + status icon */}
        <div className="flex flex-col items-center gap-1.5 pt-0.5 shrink-0">
          <PriorityDot priority={task.priority} />
          <StatusIcon size={14} style={{ color: statusCfg.color }} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3
              className="text-[13px] font-bold truncate"
              style={{ fontFamily: 'Outfit', color: 'var(--ao-text-primary)' }}
            >
              {task.title}
            </h3>
            <StatusBadge status={task.status} />
          </div>

          {!expanded && task.description && (
            <p className="text-[11px] line-clamp-1 mt-0.5" style={{ color: 'var(--ao-text-dim)' }}>
              {task.description}
            </p>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-1.5">
            {task.assigned_name && (
              <div className="flex items-center gap-1.5">
                <AgentAvatar name={task.assigned_name} />
                <span className="text-[10px] font-medium" style={{ color: 'var(--ao-text-muted)' }}>
                  {task.assigned_name}
                </span>
              </div>
            )}
            {task.client_name && (
              <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--ao-text-dim)' }}>
                <User size={10} />
                {task.client_name}
              </span>
            )}
            {task.created_at && (
              <span
                className="text-[10px] tabular-nums"
                style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-xs)' }}
              >
                {timeSince(task.created_at)}
              </span>
            )}
          </div>
        </div>

        {/* Expand chevron */}
        <div className="shrink-0 pt-1" style={{ color: 'var(--ao-text-xs)' }}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3.5 pb-3.5 pt-0 border-t" style={{ borderColor: 'var(--ao-border-subtle, rgba(255,255,255,0.04))' }}>
          {/* Full description */}
          {task.description && (
            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--ao-text-xs)' }}>
                Descricao
              </p>
              <p className="text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--ao-text-muted)' }}>
                {task.description}
              </p>
            </div>
          )}

          {/* Result (if done) */}
          {task.result && (
            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--ao-text-xs)' }}>
                Resultado
              </p>
              <p className="text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--ao-text-muted)' }}>
                {typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2)}
              </p>
            </div>
          )}

          {/* Extra info */}
          <div className="flex items-center gap-4 mt-3 text-[10px]" style={{ color: 'var(--ao-text-xs)' }}>
            {task.delegated_name && (
              <span>Delegada por: <span style={{ color: 'var(--ao-text-dim)' }}>{task.delegated_name}</span></span>
            )}
            {task.due_date && (
              <span className="flex items-center gap-1">
                <Clock size={10} />
                Prazo: {new Date(task.due_date).toLocaleDateString('pt-BR')}
              </span>
            )}
            {task.completed_at && (
              <span>Concluida: {timeSince(task.completed_at)}</span>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 mt-3">
            {(task.status === 'pending' || task.status === 'in_progress' || task.status === 'blocked') && (
              <>
                <ActionButton
                  label="Concluir"
                  icon={<CheckCircle size={12} />}
                  color="#639922"
                  loading={actionLoading === `${task.id}-done`}
                  onClick={() => onAction(task.id, 'done')}
                />
                <ActionButton
                  label="Cancelar"
                  icon={<XCircle size={12} />}
                  color="#ef4444"
                  loading={actionLoading === `${task.id}-cancelled`}
                  onClick={() => onAction(task.id, 'cancelled')}
                />
              </>
            )}
            {(task.status === 'done' || task.status === 'cancelled') && (
              <ActionButton
                label="Reabrir"
                icon={<RotateCcw size={12} />}
                color="#f59e0b"
                loading={actionLoading === `${task.id}-pending`}
                onClick={() => onAction(task.id, 'pending')}
              />
            )}
          </div>
        </div>
      )}

      {/* Urgent bar */}
      {task.priority === 'urgent' && (
        <div
          className="h-[2px] animate-pulse"
          style={{ background: `linear-gradient(90deg, ${priorityCfg.color}00, ${priorityCfg.color}60, ${priorityCfg.color}00)` }}
        />
      )}
    </div>
  )
}

function ActionButton({ label, icon, color, loading, onClick }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={loading}
      className="flex items-center gap-1 text-[10px] font-medium px-2.5 py-1 rounded-lg transition-all hover:brightness-110 disabled:opacity-50"
      style={{
        background: `${color}12`,
        color: `${color}cc`,
        border: `1px solid ${color}18`,
      }}
    >
      {loading ? <Loader size={12} className="animate-spin" /> : icon}
      {label}
    </button>
  )
}

function ClipboardList({ size, color }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" />
    </svg>
  )
}

// ============================================
// MAIN COMPONENT
// ============================================

export default function TaskBoard() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [expandedId, setExpandedId] = useState(null)
  const [actionLoading, setActionLoading] = useState(null)

  const loadTasks = useCallback(async () => {
    try {
      const data = await api.getTasks()
      setTasks(data)
    } catch {
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTasks()
    const interval = setInterval(loadTasks, 30000)
    return () => clearInterval(interval)
  }, [loadTasks])

  // Counts per status
  const counts = {
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    done: tasks.filter(t => t.status === 'done').length,
    cancelled: tasks.filter(t => t.status === 'cancelled').length,
  }

  // Filter + sort + limit
  const filtered = tasks
    .filter(t => filter === 'all' || t.status === filter)
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99
      const pb = PRIORITY_ORDER[b.priority] ?? 99
      if (pa !== pb) return pa - pb
      return new Date(b.created_at) - new Date(a.created_at)
    })
    .slice(0, 20)

  async function handleAction(taskId, newStatus) {
    const key = `${taskId}-${newStatus}`
    setActionLoading(key)
    try {
      await api.updateTask(taskId, { status: newStatus })
      await loadTasks()
    } catch (err) {
      console.error('[TaskBoard] Erro ao atualizar task:', err)
    } finally {
      setActionLoading(null)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader size={16} className="animate-spin" style={{ color: 'var(--ao-text-dim)' }} />
        <span className="ml-2 text-[12px]" style={{ color: 'var(--ao-text-dim)' }}>Carregando tarefas...</span>
      </div>
    )
  }

  return (
    <section>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="section-header">Tarefas</h2>
          {counts.blocked > 0 && (
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full animate-pulse"
              style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.1)' }}
            >
              {counts.blocked} bloqueada{counts.blocked > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <span
          className="text-[10px] tabular-nums"
          style={{ fontFamily: 'Space Grotesk', color: 'var(--ao-text-xs)' }}
        >
          {filtered.length}/{tasks.length}
        </span>
      </div>

      {/* Filter tabs */}
      <div className="mb-3">
        <FilterTabs active={filter} counts={counts} onChange={setFilter} />
      </div>

      {/* Task list */}
      {filtered.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <div className="space-y-2">
          {filtered.map((task, index) => (
            <div key={task.id} style={{ animationDelay: `${index * 40}ms` }}>
              <TaskCard
                task={task}
                expanded={expandedId === task.id}
                onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
                onAction={handleAction}
                actionLoading={actionLoading}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
