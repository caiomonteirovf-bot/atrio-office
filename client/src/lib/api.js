const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Erro na requisição')
  }
  return res.json()
}

export const api = {
  // Agents
  getAgents: () => request('/agents'),
  getAgent: (id) => request(`/agents/${id}`),

  // Team
  getTeam: () => request('/team'),

  // Chat
  sendMessage: (agentId, message, conversationId) =>
    request(`/chat/${agentId}`, {
      method: 'POST',
      body: JSON.stringify({ message, conversationId }),
    }),
  getMessages: (conversationId) =>
    request(`/conversations/${conversationId}/messages`),

  // Tasks
  getTasks: (filters = {}) => {
    const params = new URLSearchParams(filters).toString()
    return request(`/tasks${params ? `?${params}` : ''}`)
  },
  createTask: (task) =>
    request('/tasks', { method: 'POST', body: JSON.stringify(task) }),
  updateTask: (id, data) =>
    request(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Clients
  getClients: () => request('/clients'),

  // Stats
  getStats: () => request('/stats'),

  // Health
  health: () => request('/health'),
}
