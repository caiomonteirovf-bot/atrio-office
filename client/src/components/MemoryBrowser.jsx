import { useState, useEffect } from 'react'

const CATEGORIES = [
  { id: 'general', label: 'Geral', icon: '📝' },
  { id: 'clients', label: 'Clientes', icon: '👤' },
  { id: 'procedures', label: 'Procedimentos', icon: '📋' },
  { id: 'rules', label: 'Regras', icon: '⚖️' },
  { id: 'context', label: 'Contexto', icon: '🧠' },
]

export default function MemoryBrowser() {
  const [agents, setAgents] = useState([])
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [editing, setEditing] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newMemory, setNewMemory] = useState({ category: 'general', title: '', content: '', pinned: false })

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => {
      const list = d.agents || d || []
      setAgents(list)
      if (list.length > 0) setSelectedAgent(list[0])
    })
  }, [])

  const fetchMemories = (agentId, cat) => {
    if (!agentId) return
    setLoading(true)
    const params = cat ? `?category=${cat}` : ''
    fetch(`/api/agents/${agentId}/memory${params}`)
      .then(r => r.json())
      .then(d => { setMemories(d.memories || []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    if (selectedAgent) fetchMemories(selectedAgent.id, categoryFilter)
  }, [selectedAgent, categoryFilter])

  const handleCreate = async () => {
    if (!newMemory.content || !selectedAgent) return
    await fetch(`/api/agents/${selectedAgent.id}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newMemory)
    })
    setShowCreate(false)
    setNewMemory({ category: 'general', title: '', content: '', pinned: false })
    fetchMemories(selectedAgent.id, categoryFilter)
  }

  const handleUpdate = async (mem) => {
    await fetch(`/api/agents/${selectedAgent.id}/memory/${mem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mem.content, title: mem.title, category: mem.category, pinned: mem.pinned })
    })
    setEditing(null)
    fetchMemories(selectedAgent.id, categoryFilter)
  }

  const handleDelete = async (memId) => {
    await fetch(`/api/agents/${selectedAgent.id}/memory/${memId}`, { method: 'DELETE' })
    fetchMemories(selectedAgent.id, categoryFilter)
  }

  const handleTogglePin = async (mem) => {
    await fetch(`/api/agents/${selectedAgent.id}/memory/${mem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !mem.pinned })
    })
    fetchMemories(selectedAgent.id, categoryFilter)
  }

  const formatDate = (d) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h2 style={{ color: 'var(--ao-text-primary)', fontSize: 20, fontWeight: 700, margin: 0 }}>
            🧠 Memória dos Agentes
          </h2>
          <p style={{ color: 'var(--ao-text-muted)', fontSize: 13, margin: '4px 0 0' }}>
            Navegue e edite o conhecimento de cada agente
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} style={{
          padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(196,149,106,0.3)',
          background: 'rgba(196,149,106,0.12)', color: '#C4956A', fontSize: 13, cursor: 'pointer', fontWeight: 600,
        }}>
          + Nova Memória
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20 }}>
        {/* Agent sidebar */}
        <div>
          <div style={{
            background: 'linear-gradient(135deg, var(--ao-glass) 0%, var(--ao-glass-half) 100%)',
            backdropFilter: 'blur(12px)', border: '1px solid var(--ao-border)',
            borderRadius: 12, padding: 12,
          }}>
            <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', textTransform: 'uppercase', padding: '4px 8px', marginBottom: 4 }}>
              Agentes
            </div>
            {agents.map(a => (
              <div
                key={a.id}
                onClick={() => { setSelectedAgent(a); setEditing(null) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px',
                  borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                  background: selectedAgent?.id === a.id ? 'rgba(196,149,106,0.12)' : 'transparent',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: selectedAgent?.id === a.id ? 'rgba(196,149,106,0.2)' : 'var(--ao-input-bg)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700,
                  color: selectedAgent?.id === a.id ? '#C4956A' : 'var(--ao-text-muted)',
                }}>
                  {a.name[0]}
                </div>
                <div>
                  <div style={{ fontSize: 13, color: selectedAgent?.id === a.id ? '#C4956A' : 'var(--ao-text-secondary)', fontWeight: 600 }}>
                    {a.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--ao-text-dim)' }}>{a.role}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Category filter */}
          <div style={{
            background: 'linear-gradient(135deg, var(--ao-glass) 0%, var(--ao-glass-half) 100%)',
            backdropFilter: 'blur(12px)', border: '1px solid var(--ao-border)',
            borderRadius: 12, padding: 12, marginTop: 12,
          }}>
            <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', textTransform: 'uppercase', padding: '4px 8px', marginBottom: 4 }}>
              Categorias
            </div>
            <div
              onClick={() => setCategoryFilter('')}
              style={{
                padding: '8px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                color: !categoryFilter ? '#C4956A' : 'var(--ao-text-secondary)',
                background: !categoryFilter ? 'rgba(196,149,106,0.1)' : 'transparent',
                marginBottom: 2,
              }}
            >
              📦 Todas
            </div>
            {CATEGORIES.map(c => (
              <div
                key={c.id}
                onClick={() => setCategoryFilter(c.id)}
                style={{
                  padding: '8px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  color: categoryFilter === c.id ? '#C4956A' : 'var(--ao-text-secondary)',
                  background: categoryFilter === c.id ? 'rgba(196,149,106,0.1)' : 'transparent',
                  marginBottom: 2,
                }}
              >
                {c.icon} {c.label}
              </div>
            ))}
          </div>
        </div>

        {/* Memory content */}
        <div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--ao-text-muted)' }}>Carregando...</div>
          ) : memories.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: 60,
              background: 'linear-gradient(135deg, var(--ao-glass) 0%, var(--ao-glass-half) 100%)',
              backdropFilter: 'blur(12px)', border: '1px solid var(--ao-border)',
              borderRadius: 12, color: 'var(--ao-text-dim)', fontSize: 14,
            }}>
              {selectedAgent ? `${selectedAgent.name} não possui memórias${categoryFilter ? ' nesta categoria' : ''}.` : 'Selecione um agente'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {memories.map(mem => (
                <div key={mem.id} style={{
                  background: 'linear-gradient(135deg, var(--ao-glass) 0%, var(--ao-glass-half) 100%)',
                  backdropFilter: 'blur(12px)',
                  border: `1px solid ${mem.pinned ? 'rgba(196,149,106,0.15)' : 'var(--ao-border)'}`,
                  borderRadius: 10, padding: 18,
                }}>
                  {editing === mem.id ? (
                    /* Edit mode */
                    <div>
                      <input
                        value={mem.title || ''}
                        onChange={e => setMemories(ms => ms.map(m => m.id === mem.id ? { ...m, title: e.target.value } : m))}
                        placeholder="Título"
                        style={{
                          width: '100%', padding: '8px 12px', borderRadius: 6, marginBottom: 8,
                          background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border-hover)',
                          color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
                        }}
                      />
                      <textarea
                        value={mem.content}
                        onChange={e => setMemories(ms => ms.map(m => m.id === mem.id ? { ...m, content: e.target.value } : m))}
                        rows={8}
                        style={{
                          width: '100%', padding: '8px 12px', borderRadius: 6, resize: 'vertical',
                          background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border-hover)',
                          color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none', fontFamily: 'monospace',
                          lineHeight: 1.6, boxSizing: 'border-box',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button onClick={() => handleUpdate(mem)} style={{
                          padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(196,149,106,0.3)',
                          background: 'rgba(196,149,106,0.15)', color: '#C4956A', fontSize: 12, cursor: 'pointer', fontWeight: 600,
                        }}>Salvar</button>
                        <button onClick={() => { setEditing(null); fetchMemories(selectedAgent.id, categoryFilter) }} style={{
                          padding: '6px 14px', borderRadius: 6, border: '1px solid var(--ao-border-hover)',
                          background: 'var(--ao-input-bg)', color: 'var(--ao-text-secondary)', fontSize: 12, cursor: 'pointer',
                        }}>Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    /* View mode */
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {mem.pinned && <span style={{ fontSize: 12 }}>📌</span>}
                          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ao-text-primary)' }}>
                            {mem.title || 'Sem título'}
                          </span>
                          <span style={{
                            padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 600,
                            textTransform: 'uppercase',
                            background: 'rgba(196,149,106,0.1)', color: '#C4956A',
                          }}>
                            {mem.category}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => handleTogglePin(mem)} title={mem.pinned ? 'Desafixar' : 'Fixar'} style={{
                            padding: '4px 8px', borderRadius: 4, border: 'none',
                            background: 'var(--ao-input-bg)', color: mem.pinned ? '#C4956A' : 'var(--ao-text-dim)',
                            fontSize: 12, cursor: 'pointer',
                          }}>📌</button>
                          <button onClick={() => setEditing(mem.id)} style={{
                            padding: '4px 8px', borderRadius: 4, border: 'none',
                            background: 'var(--ao-input-bg)', color: 'var(--ao-text-muted)',
                            fontSize: 12, cursor: 'pointer',
                          }}>✏️</button>
                          <button onClick={() => handleDelete(mem.id)} style={{
                            padding: '4px 8px', borderRadius: 4, border: 'none',
                            background: 'var(--ao-input-bg)', color: '#f87171',
                            fontSize: 12, cursor: 'pointer',
                          }}>🗑</button>
                        </div>
                      </div>
                      <div style={{
                        fontSize: 13, color: 'var(--ao-text-secondary)', lineHeight: 1.6,
                        whiteSpace: 'pre-wrap', fontFamily: 'monospace',
                        maxHeight: 200, overflow: 'auto',
                      }}>
                        {mem.content}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--ao-text-xs)', marginTop: 8 }}>
                        Atualizado: {formatDate(mem.updated_at)}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create modal */}
      {showCreate && (
        <div onClick={() => setShowCreate(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: 500, background: 'var(--ao-card)', borderRadius: 12,
            border: '1px solid var(--ao-border-hover)', padding: 24,
          }}>
            <h3 style={{ color: 'var(--ao-text-primary)', fontSize: 16, fontWeight: 700, margin: '0 0 16px' }}>
              Nova Memória — {selectedAgent?.name}
            </h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-muted)', marginBottom: 4 }}>Categoria</label>
              <select value={newMemory.category} onChange={e => setNewMemory(n => ({ ...n, category: e.target.value }))} style={{
                width: '100%', padding: '8px 12px', borderRadius: 6,
                background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border-hover)',
                color: 'var(--ao-text-primary)', fontSize: 12, outline: 'none', colorScheme: 'dark',
              }}>
                {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-muted)', marginBottom: 4 }}>Título</label>
              <input value={newMemory.title} onChange={e => setNewMemory(n => ({ ...n, title: e.target.value }))} placeholder="Título da memória" style={{
                width: '100%', padding: '8px 12px', borderRadius: 6,
                background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border-hover)',
                color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
              }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--ao-text-muted)', marginBottom: 4 }}>Conteúdo</label>
              <textarea value={newMemory.content} onChange={e => setNewMemory(n => ({ ...n, content: e.target.value }))} rows={8} placeholder="Markdown ou texto livre..." style={{
                width: '100%', padding: '8px 12px', borderRadius: 6, resize: 'vertical',
                background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border-hover)',
                color: 'var(--ao-text-primary)', fontSize: 13, outline: 'none', fontFamily: 'monospace',
                lineHeight: 1.6, boxSizing: 'border-box',
              }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ao-text-secondary)', marginBottom: 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={newMemory.pinned} onChange={e => setNewMemory(n => ({ ...n, pinned: e.target.checked }))} />
              Fixar no topo
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowCreate(false)} style={{
                flex: 1, padding: '8px 0', borderRadius: 6, border: '1px solid var(--ao-border-hover)',
                background: 'var(--ao-input-bg)', color: 'var(--ao-text-secondary)', fontSize: 12, cursor: 'pointer',
              }}>Cancelar</button>
              <button onClick={handleCreate} style={{
                flex: 1, padding: '8px 0', borderRadius: 6, border: '1px solid rgba(196,149,106,0.3)',
                background: 'rgba(196,149,106,0.15)', color: '#C4956A', fontSize: 12, cursor: 'pointer', fontWeight: 600,
              }}>Criar Memória</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
