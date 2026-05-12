import { useEffect, useState, useMemo, useRef } from 'react'
import { FileText, Search, X, Plus, Loader2, Trash2 } from 'lucide-react'

/**
 * Popover de templates — lista + busca + click insere no input do chat.
 *
 * Props:
 *  - open, onClose
 *  - onPick(text): chamado quando usuario escolhe template
 *       (text ja vem com {nome}, {hoje}, {mes} substituidos — placeholders livres ficam)
 *  - conversation: {client_name, phone, ...} pra substituir variaveis auto
 *  - currentInput: texto atual no input (pra opcao "Salvar como template")
 */
export default function TemplatePicker({ open, onClose, onPick, conversation, currentInput = '' }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState('outros')
  const inputRef = useRef(null)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/atendimento/templates')
      const j = await r.json()
      setTemplates(Array.isArray(j?.data) ? j.data : [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { if (open) { load(); setTimeout(() => inputRef.current?.focus(), 50) } }, [open])

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term) return templates
    return templates.filter(t =>
      t.name.toLowerCase().includes(term) ||
      (t.body || '').toLowerCase().includes(term) ||
      (t.category || '').toLowerCase().includes(term)
    )
  }, [templates, q])

  /**
   * Substitui variaveis "auto" ({nome}, {cliente}, {hoje}, {mes}) com dados da conversa.
   * Outras variaveis entre {} ficam intactas pra usuario preencher no input.
   */
  const resolveVars = (text) => {
    if (!text) return ''
    const clientFull = String(conversation?.client_name || '').trim()
    const firstName = clientFull.split(/\s+/)[0] || ''
    const now = new Date()
    const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
    const hoje = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`
    const mes = meses[now.getMonth()]

    return text
      .replace(/\{nome\}/gi, firstName || '{nome}')
      .replace(/\{cliente\}/gi, clientFull || '{cliente}')
      .replace(/\{hoje\}/gi, hoje)
      .replace(/\{mes\}/gi, mes)
  }

  const handlePick = async (tpl) => {
    const text = resolveVars(tpl.body || '')
    onPick?.(text)
    // Track uso (fire-and-forget)
    fetch(`/api/atendimento/templates/${tpl.id}/track-use`, { method: 'POST' }).catch(() => {})
    onClose?.()
  }

  const handleSaveCurrent = async () => {
    if (!currentInput.trim() || !newName.trim()) return
    setCreating(true); setError(null)
    try {
      const r = await fetch('/api/atendimento/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), category: newCategory, body: currentInput.trim() }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha ao salvar')
      setNewName('')
      await load()
    } catch (e) { setError(e.message) }
    finally { setCreating(false) }
  }

  const handleDelete = async (id, e) => {
    e.stopPropagation()
    if (!confirm('Arquivar este template? (Pode ser restaurado direto no banco)')) return
    try {
      await fetch(`/api/atendimento/templates/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) { setError(e.message) }
  }

  if (!open) return null

  const categoryColors = {
    fiscal:     { bg: 'rgba(99, 102, 241, 0.15)', fg: '#6366F1' },
    cobranca:   { bg: 'rgba(239, 68, 68, 0.15)',  fg: '#EF4444' },
    documentos: { bg: 'rgba(245, 158, 11, 0.15)', fg: '#F59E0B' },
    saudacao:   { bg: 'rgba(16, 185, 129, 0.15)', fg: '#10B981' },
    outros:     { bg: 'rgba(100, 116, 139, 0.15)', fg: '#64748B' },
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 180,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        padding: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 520, maxHeight: '82vh',
          background: 'var(--ao-card)', borderRadius: 12,
          border: '1px solid var(--ao-border)',
          display: 'flex', flexDirection: 'column',
          color: 'var(--ao-text-primary)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid var(--ao-border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <FileText size={15} style={{ color: 'var(--ao-accent, #6366F1)' }} />
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, flex: 1 }}>Templates</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--ao-text-dim)', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Busca */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--ao-border)' }}>
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 8, top: 8, opacity: 0.5 }} />
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Buscar por nome, texto ou categoria..."
              style={{
                width: '100%', padding: '6px 8px 6px 26px',
                fontSize: 12, borderRadius: 6,
                border: '1px solid var(--ao-border)',
                background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
              }}
            />
          </div>
        </div>

        {/* Lista */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: 20, opacity: 0.5 }}>
              <Loader2 size={14} className="animate-spin" />
            </div>
          )}
          {error && <div style={{ padding: 10, fontSize: 11, color: '#ef4444' }}>{error}</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: 20, opacity: 0.4, fontSize: 12 }}>
              {q ? 'Nenhum template casou' : 'Nenhum template ainda'}
            </div>
          )}
          {filtered.map(tpl => {
            const cat = categoryColors[tpl.category] || categoryColors.outros
            return (
              <button
                key={tpl.id}
                onClick={() => handlePick(tpl)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '8px 10px', marginBottom: 4, borderRadius: 6,
                  border: '1px solid var(--ao-border)',
                  background: 'var(--ao-bg)',
                  color: 'var(--ao-text-primary)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ao-surface)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--ao-bg)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                    background: cat.bg, color: cat.fg, textTransform: 'uppercase',
                  }}>
                    {tpl.category || 'outros'}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{tpl.name}</span>
                  {tpl.usage_count > 0 && (
                    <span style={{ fontSize: 10, opacity: 0.5 }}>usado {tpl.usage_count}x</span>
                  )}
                  <button
                    onClick={(e) => handleDelete(tpl.id, e)}
                    title="Arquivar"
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--ao-text-dim)', padding: 2,
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                  {String(tpl.body || '').slice(0, 140)}{(tpl.body || '').length > 140 ? '...' : ''}
                </div>
              </button>
            )
          })}
        </div>

        {/* Salvar como template */}
        {currentInput.trim().length >= 10 && (
          <div style={{
            padding: '8px 12px', borderTop: '1px solid var(--ao-border)',
            background: 'var(--ao-surface)',
          }}>
            <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 4, fontWeight: 600, textTransform: 'uppercase' }}>
              Salvar o texto atual do input como novo template
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Nome do template..."
                style={{
                  flex: 1, padding: '6px 8px', fontSize: 11.5, borderRadius: 5,
                  border: '1px solid var(--ao-border)',
                  background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
                }}
              />
              <select
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                style={{
                  padding: '6px 8px', fontSize: 11, borderRadius: 5,
                  border: '1px solid var(--ao-border)',
                  background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
                }}
              >
                <option value="fiscal">Fiscal</option>
                <option value="cobranca">Cobrança</option>
                <option value="documentos">Documentos</option>
                <option value="saudacao">Saudação</option>
                <option value="outros">Outros</option>
              </select>
              <button
                onClick={handleSaveCurrent}
                disabled={creating || !newName.trim()}
                style={{
                  padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 5,
                  border: 'none', cursor: creating ? 'wait' : 'pointer',
                  background: newName.trim() ? 'var(--ao-accent, #6366F1)' : 'var(--ao-border)',
                  color: newName.trim() ? '#fff' : 'var(--ao-text-dim)',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                Salvar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
