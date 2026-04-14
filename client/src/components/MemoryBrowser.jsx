import { useState, useEffect } from 'react'

const CATS = [
  { id: 'general', label: 'Geral', icon: '' },
  { id: 'fiscal_rule', label: 'Fiscal', icon: '' },
  { id: 'financial', label: 'Financeiro', icon: '' },
  { id: 'corporate', label: 'Societrio', icon: '' },
  { id: 'client', label: 'Clientes', icon: '' },
  { id: 'process', label: 'Processos', icon: '' },
]

const fmt = (d) => {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch(e) { return '' }
}

export default function MemoryBrowser() {
  const [tab, setTab] = useState('knowledge')
  const [memories, setMemories] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [audit, setAudit] = useState([])
  const [agents, setAgents] = useState([])
  const [stats, setStats] = useState({ active: '0', pending_review: '0', total: '0' })
  const [selAgent, setSelAgent] = useState(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [reviewFilter, setReviewFilter] = useState('pending')
  const [newMem, setNewMem] = useState({ title: '', content: '', category: 'general', summary: '', agent_id: null })

  useEffect(() => {
    fetch('/api/agents').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setAgents(d)
      else if (d && Array.isArray(d.agents)) setAgents(d.agents)
      else setAgents([])
    }).catch(() => setAgents([]))
  }, [])

  useEffect(() => {
    setLoading(true)
    const p = new URLSearchParams({ status: 'approved', limit: '100' })
    if (selAgent) p.set('agent', selAgent)
    if (search) p.set('search', search)
    fetch('/api/memory?' + p.toString())
      .then(r => r.json())
      .then(d => {
        setMemories(Array.isArray(d.memories) ? d.memories : [])
        if (d.stats) setStats(d.stats)
        setLoading(false)
      })
      .catch(() => { setMemories([]); setLoading(false) })
  }, [selAgent, search])

  useEffect(() => {
    if (tab !== 'review') return
    fetch('/api/memory/suggestions?status=' + reviewFilter + '&limit=50')
      .then(r => r.json())
      .then(d => setSuggestions(Array.isArray(d.suggestions) ? d.suggestions : []))
      .catch(() => setSuggestions([]))
  }, [tab, reviewFilter])

  useEffect(() => {
    if (tab !== 'history') return
    fetch('/api/memory/audit?limit=100')
      .then(r => r.json())
      .then(d => setAudit(Array.isArray(d.audit) ? d.audit : []))
      .catch(() => setAudit([]))
  }, [tab])

  const handleTeach = () => {
    if (!newMem.title || !newMem.content) return
    fetch('/api/memory/teach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newMem)
    }).then(() => {
      setNewMem({ title: '', content: '', category: 'general', summary: '', agent_id: null })
      setTab('knowledge')
    }).catch(() => {})
  }

  const handleApprove = (id) => {
    fetch('/api/memory/suggestions/' + id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(() => { setTab('review') }).catch(() => {})
  }

  const handleReject = (id) => {
    fetch('/api/memory/suggestions/' + id + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(() => { setTab('review') }).catch(() => {})
  }

  const pill = (active) => ({
    padding: '6px 14px', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: 500, display: 'inline-block',
    background: active ? 'rgba(196,149,106,0.18)' : 'rgba(255,255,255,0.04)',
    color: active ? '#C4956A' : 'rgba(255,255,255,0.55)',
    border: '1px solid ' + (active ? 'rgba(196,149,106,0.3)' : 'rgba(255,255,255,0.08)'),
  })

  const card = {
    padding: '16px 20px', borderRadius: 12, marginBottom: 10,
    background: 'linear-gradient(135deg, rgba(19,22,32,0.7) 0%, rgba(19,22,32,0.5) 100%)',
    border: '1px solid rgba(255,255,255,0.06)',
  }

  const tabStyle = (active) => ({
    padding: '10px 18px', cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400,
    color: active ? '#C4956A' : 'rgba(255,255,255,0.5)',
    background: 'none', border: 'none',
    borderBottom: active ? '2px solid #C4956A' : '2px solid transparent',
  })

  const inp = {
    width: '100%', padding: '10px 14px', borderRadius: 8, fontSize: 13, boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.85)', outline: 'none',
  }

  const tag = { padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 500, background: 'rgba(196,149,106,0.12)', color: '#C4956A', display: 'inline-block', marginRight: 6 }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100 }}>
      <h1 style={{ color: 'rgba(255,255,255,0.92)', fontSize: 22, fontWeight: 700, margin: 0 }}>Conhecimento da Equipe</h1>
      <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13, margin: '4px 0 0' }}>Tudo que os agentes aprenderam e usam no dia a dia</p>

      <div style={{ display: 'flex', gap: 16, margin: '20px 0' }}>
        {[
          { v: stats.active, l: 'Conhecimentos ativos', c: '#4ade80' },
          { v: stats.pending_review, l: 'Aguardando sua revisao', c: 'rgba(255,255,255,0.5)' },
          { v: stats.total, l: 'Total registrado', c: 'rgba(255,255,255,0.5)' },
        ].map((s, i) => (
          <div key={i} style={{ flex: 1, padding: '18px 20px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.c, lineHeight: 1 }}>{s.v}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 6 }}>{s.l}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 16 }}>
        <button style={tabStyle(tab === 'knowledge')} onClick={() => setTab('knowledge')}>O que cada agente sabe</button>
        <button style={tabStyle(tab === 'review')} onClick={() => setTab('review')}>Revisar</button>
        <button style={tabStyle(tab === 'teach')} onClick={() => setTab('teach')}>+ Ensinar algo novo</button>
        <button style={tabStyle(tab === 'history')} onClick={() => setTab('history')}>Historico</button>
      </div>

      {tab === 'knowledge' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={pill(!selAgent)} onClick={() => setSelAgent(null)}>Todos</span>
              {agents.map(a => (
                <span key={a.id} style={pill(selAgent === a.name)} onClick={() => setSelAgent(selAgent === a.name ? null : a.name)}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: a.status === 'online' ? '#4ade80' : '#666', display: 'inline-block', marginRight: 6 }}></span>
                  {a.name}
                </span>
              ))}
            </div>
            <input style={{ ...inp, width: 220 }} placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 48, color: 'rgba(255,255,255,0.3)' }}>Carregando...</div>
          ) : memories.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}></div>
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14 }}>Nenhum conhecimento registrado ainda</div>
              <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, marginTop: 4 }}>Use a aba "+ Ensinar algo novo" para adicionar</div>
            </div>
          ) : memories.map(mem => (
            <div key={mem.id} style={card}>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.88)', margin: 0 }}>{mem.title}</p>
              {mem.summary && <div style={{ fontSize: 12, color: '#C4956A', marginTop: 4, fontStyle: 'italic' }}>{mem.summary}</div>}
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: '8px 0 0', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {mem.content && mem.content.length > 300 ? mem.content.substring(0, 300) + '...' : mem.content}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {mem.agent_name && <span style={tag}> {mem.agent_name}</span>}
                <span style={tag}>{mem.category}</span>
                {mem.confidence_score && <span style={tag}> {Math.round(Number(mem.confidence_score) * 100)}%</span>}
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{fmt(mem.updated_at)}</span>
                {mem.source_type && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>via {mem.source_type}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'review' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <span style={pill(reviewFilter === 'pending')} onClick={() => setReviewFilter('pending')}>Pendentes</span>
            <span style={pill(reviewFilter === 'approved')} onClick={() => setReviewFilter('approved')}>Aprovadas</span>
            <span style={pill(reviewFilter === 'rejected')} onClick={() => setReviewFilter('rejected')}>Rejeitadas</span>
          </div>
          {suggestions.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}></div>
              <div style={{ color: 'rgba(255,255,255,0.4)' }}>Nada para revisar no momento</div>
            </div>
          ) : suggestions.map(sug => (
            <div key={sug.id} style={card}>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.88)', margin: 0 }}>{sug.title}</p>
              {sug.agent_name && <span style={{ fontSize: 11, color: '#C4956A' }}>Agente: {sug.agent_name}</span>}
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: '8px 0', lineHeight: 1.5 }}>{sug.proposed_content || sug.reason}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={tag}>{sug.trigger_type || 'manual'}</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{fmt(sug.created_at)}</span>
              </div>
              {reviewFilter === 'pending' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button onClick={() => handleApprove(sug.id)} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.3)' }}> Aprovar</button>
                  <button onClick={() => handleReject(sug.id)} style={{ padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}> Rejeitar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'teach' && (
        <div style={{ maxWidth: 600, marginTop: 8 }}>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, margin: '0 0 16px' }}>Ensine algo novo para um agente ou para toda a equipe.</p>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Para quem?</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={pill(!newMem.agent_id)} onClick={() => setNewMem({...newMem, agent_id: null})}>Todos os agentes</span>
              {agents.map(a => (
                <span key={a.id} style={pill(newMem.agent_id === a.id)} onClick={() => setNewMem({...newMem, agent_id: newMem.agent_id === a.id ? null : a.id})}>{a.name}</span>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Sobre o que?</label>
            <select style={inp} value={newMem.category} onChange={e => setNewMem({...newMem, category: e.target.value})}>
              {CATS.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Titulo</label>
            <input style={inp} placeholder="Ex: Prazo do Simples Nacional" value={newMem.title} onChange={e => setNewMem({...newMem, title: e.target.value})} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>O que o agente precisa saber?</label>
            <textarea style={{ ...inp, minHeight: 120, resize: 'vertical' }} placeholder="Escreva aqui a informacao que o agente deve lembrar..." value={newMem.content} onChange={e => setNewMem({...newMem, content: e.target.value})} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Resumo curto (opcional)</label>
            <input style={inp} placeholder="Uma frase que resume a informacao" value={newMem.summary} onChange={e => setNewMem({...newMem, summary: e.target.value})} />
          </div>
          <button onClick={handleTeach} style={{ padding: '10px 24px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer', background: 'rgba(196,149,106,0.15)', color: '#C4956A', border: '1px solid rgba(196,149,106,0.3)' }}>Ensinar</button>
        </div>
      )}

      {tab === 'history' && (
        <div>
          {audit.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ color: 'rgba(255,255,255,0.4)' }}>Nenhuma acao registrada ainda</div>
            </div>
          ) : audit.map(a => (
            <div key={a.id} style={{ ...card, padding: '12px 18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{a.action}{a.memory_title ? '  ' + a.memory_title : ''}</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{fmt(a.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
