import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'

function timeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000)
  if (seconds < 60) return 'agora'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export default function ActivityFeed() {
  const [tasks, setTasks] = useState([])
  const [visible, setVisible] = useState(true)
  const prevCountRef = useRef(0)
  const [newItems, setNewItems] = useState(new Set())

  useEffect(() => {
    loadTasks()
    const interval = setInterval(loadTasks, 10000)
    return () => clearInterval(interval)
  }, [])

  async function loadTasks() {
    try {
      const data = await api.getTasks()
      if (data.length > prevCountRef.current && prevCountRef.current > 0) {
        const newIds = new Set(data.slice(0, data.length - prevCountRef.current).map(t => t.id))
        setNewItems(newIds)
        setTimeout(() => setNewItems(new Set()), 2000)
      }
      prevCountRef.current = data.length
      setTasks(data.slice(0, 8))
    } catch { setTasks([]) }
  }

  const statusIcons = {
    pending: { icon: '○', color: 'text-slate-500' },
    in_progress: { icon: '◐', color: 'text-indigo-400' },
    done: { icon: '●', color: 'text-emerald-400' },
    blocked: { icon: '◆', color: 'text-red-400' },
    cancelled: { icon: '○', color: 'text-slate-700' },
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">Atividade recente</h2>
        <button onClick={() => setVisible(!visible)} className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors">
          {visible ? 'Minimizar' : 'Expandir'}
        </button>
      </div>

      {visible && (
        <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl overflow-hidden">
          {tasks.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-slate-500 text-[12px]">Nenhuma atividade registrada</p>
              <p className="text-slate-600 text-[10px] mt-1">As tarefas delegadas pelos agentes aparecerão aqui</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-700/30">
              {tasks.map(task => {
                const st = statusIcons[task.status] || statusIcons.pending
                const isNew = newItems.has(task.id)
                return (
                  <div key={task.id} className={`flex items-center gap-3 px-4 py-3 transition-all duration-500 ${isNew ? 'bg-indigo-500/5' : 'hover:bg-slate-700/20'}`}>
                    <span className={`text-[12px] ${st.color}`}>{st.icon}</span>
                    <div className="w-0.5 h-6 rounded-full shrink-0" style={{
                      backgroundColor: task.priority === 'urgent' ? '#EF4444' : task.priority === 'high' ? '#F59E0B' : task.priority === 'medium' ? '#6366f1' : '#334155',
                    }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-slate-300 truncate">{task.title}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {task.assigned_name && <span className="text-[10px] text-slate-500">→ {task.assigned_name}</span>}
                        {task.client_name && <span className="text-[10px] text-slate-600">• {task.client_name}</span>}
                      </div>
                    </div>
                    <span className="text-[10px] text-slate-600 tabular-nums shrink-0">{timeAgo(task.created_at)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
