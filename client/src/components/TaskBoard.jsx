import { useState, useEffect } from 'react'
import { Clock, AlertTriangle, CheckCircle, Circle, Loader } from 'lucide-react'
import { api } from '../lib/api'

const STATUS_CONFIG = {
  pending: { label: 'Pendente', icon: Circle, color: 'text-text-muted' },
  in_progress: { label: 'Em andamento', icon: Loader, color: 'text-agent-campelo' },
  done: { label: 'Concluída', icon: CheckCircle, color: 'text-agent-sneijder' },
  blocked: { label: 'Bloqueada', icon: AlertTriangle, color: 'text-red-400' },
  cancelled: { label: 'Cancelada', icon: Circle, color: 'text-text-muted' },
}

const PRIORITY_COLORS = {
  urgent: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-agent-campelo',
  low: 'border-l-text-muted',
}

export default function TaskBoard() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getTasks()
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-text-muted text-sm">
        Carregando tarefas...
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="bg-void-light border border-void-border rounded-xl p-8 text-center">
        <ClipboardList className="mx-auto mb-3 text-text-muted" size={32} />
        <p className="text-text-secondary text-sm">Nenhuma tarefa no momento</p>
        <p className="text-text-muted text-xs mt-1">As tarefas delegadas por Rodrigo aparecerão aqui</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {tasks.map(task => {
        const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending
        const StatusIcon = config.icon
        return (
          <div
            key={task.id}
            className={`bg-void-light border border-void-border rounded-lg p-3 border-l-2 ${PRIORITY_COLORS[task.priority] || ''}`}
          >
            <div className="flex items-start gap-3">
              <StatusIcon size={16} className={`mt-0.5 shrink-0 ${config.color}`} />
              <div className="flex-1 min-w-0">
                <p className="text-text-primary text-sm font-medium truncate">{task.title}</p>
                {task.description && (
                  <p className="text-text-muted text-xs mt-0.5 line-clamp-2">{task.description}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
                  {task.assigned_name && (
                    <span className="flex items-center gap-1">
                      <span className="w-4 h-4 rounded bg-void-lighter text-[10px] flex items-center justify-center">
                        {task.assigned_name[0]}
                      </span>
                      {task.assigned_name}
                    </span>
                  )}
                  {task.due_date && (
                    <span className="flex items-center gap-1">
                      <Clock size={12} />
                      {new Date(task.due_date).toLocaleDateString('pt-BR')}
                    </span>
                  )}
                  <span className={config.color}>{config.label}</span>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ClipboardList({ className, size }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>
    </svg>
  )
}
