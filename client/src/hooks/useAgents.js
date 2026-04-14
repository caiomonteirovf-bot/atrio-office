import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'

// Determina o estado de atividade real do agente baseado nas tasks
function resolveActivity(teamMemberId, tasks) {
  if (!teamMemberId) return { activity: 'standby', taskTitle: null, taskCount: 0 }
  const agentTasks = tasks.filter(t => t.assigned_to === teamMemberId)
  const inProgress = agentTasks.filter(t => t.status === 'in_progress')
  const blocked = agentTasks.filter(t => t.status === 'blocked')
  const pending = agentTasks.filter(t => t.status === 'pending')

  if (inProgress.length > 0) {
    return { activity: 'working', taskTitle: inProgress[0].title, taskCount: inProgress.length }
  }
  if (blocked.length > 0) {
    return { activity: 'blocked', taskTitle: blocked[0].title, taskCount: blocked.length }
  }
  if (pending.length > 0) {
    return { activity: 'pending', taskTitle: pending[0].title, taskCount: pending.length }
  }
  return { activity: 'standby', taskTitle: null, taskCount: 0 }
}

export function useAgents() {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [agentsData, teamData, allTasks] = await Promise.all([
        api.getAgents(),
        api.getTeam(),
        api.getTasks(),
      ])
      // Mapeia agent_id → team_member_id
      const teamByAgentId = {}
      for (const tm of teamData || []) {
        if (tm.agent_id) teamByAgentId[tm.agent_id] = tm.id
      }
      // Enriquece cada agente com estado de atividade real
      const enriched = agentsData.map(agent => ({
        ...agent,
        teamMemberId: teamByAgentId[agent.id] || null,
        ...resolveActivity(teamByAgentId[agent.id], allTasks || []),
      }))
      setAgents(enriched)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // Atualiza a cada 10s para refletir mudanças de estado
    const interval = setInterval(refresh, 10000)
    return () => clearInterval(interval)
  }, [refresh])

  return { agents, loading, error, refresh }
}
