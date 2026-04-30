import { useEffect, useState, useMemo } from 'react'
import {
  FileText, Plus, Edit2, Trash2, Archive, RefreshCw, Search, Loader2, X, Save, Copy,
} from 'lucide-react'

/**
 * Templates Manager — pagina de gestao dos templates de atendimento WhatsApp.
 * CRUD completo sem precisar SQL direto.
 */

const CATEGORIAS = [
  { id: 'fiscal',     label: 'Fiscal',     color: '#6366F1' },
  { id: 'cobranca',   label: 'Cobrança',   color: '#EF4444' },
  { id: 'documentos', label: 'Documentos', color: '#F59E0B' },
  { id: 'saudacao',   label: 'Saudação',   color: '#10B981' },
  { id: 'outros',     label: 'Outros',     color: '#64748B' },
]

const VARIAVEIS_DISPONIVEIS = [
  { key: '{nome}',     desc: 'Primeiro nome do cliente' },
  { key: '{cliente}',  desc: 'Nome completo do cliente' },
  { key: '{hoje}',     desc: 'Data atual (dd/mm)' },
  { key: '{mes}',      desc: 'Mês atual por extenso' },
  { key: '{valor}',    desc: 'Campo livre — operador preenche ao usar' },
  { key: '{numero}',   desc: 'Campo livre — ex: número da NFS-e' },
  { key: '{documento}',desc: 'Campo livre — ex: contrato social' },
]

export default function TemplatesManager() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filterCat, setFilterCat] = useState('')
  const [filterQ, setFilterQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState(null)  // null | 'new' | template object
  const [form, setForm] = useState({ name: '', category: 'outros', body: '' })
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/atendimento/templates')
      const j = await r.json()
      setItems(Array.isArray(j?.data) ? j.data : [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    let list = items
    if (!showArchived) list = list.filter(t => t.is_active !== false)
    if (filterCat) list = list.filter(t => t.category === filterCat)
    if (filterQ) {
      const term = filterQ.trim().toLowerCase()
      list = list.filter(t =>
        (t.name || '').toLowerCase().includes(term) ||
        (t.body || '').toLowerCase().includes(term)
      )
    }
    return list
  }, [items, filterCat, filterQ, showArchived])

  const openNew = () => {
    setForm({ name: '', category: 'outros', body: '' })
    setEditing('new')
  }
  const openEdit = (t) => {
    setForm({ name: t.name || '', category: t.category || 'outros', body: t.body || '' })
    setEditing(t)
  }
  const close = () => { setEditing(null); setSaving(false) }

  const save = async () => {
    if (!form.name.trim() || !form.body.trim()) {
      alert('Nome e mensagem são obrigatórios')
      return
    }
    setSaving(true)
    try {
      const isNew = editing === 'new'
      const url = isNew ? '/api/atendimento/templates' : `/api/atendimento/templates/${editing.id}`
      const method = isNew ? 'POST' : 'PATCH'
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          category: form.category,
          body: form.body,
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'falha ao salvar')
      close()
      await load()
    } catch (e) {
      alert('Erro: ' + e.message)
      setSaving(false)
    }
  }

  const archive = async (t) => {
    if (!confirm(`Arquivar "${t.name}"? Pode ser restaurado editando o is_active.`)) return
    try {
      await fetch(`/api/atendimento/templates/${t.id}`, { method: 'DELETE' })
      await load()
    } catch (e) { alert('Erro: ' + e.message) }
  }

  const unarchive = async (t) => {
    try {
      await fetch(`/api/atendimento/templates/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true }),
      })
      await load()
    } catch (e) { alert('Erro: ' + e.message) }
  }

  const duplicate = (t) => {
    setForm({
      name: `${t.name} (cópia)`,
      category: t.category,
      body: t.body,
    })
    setEditing('new')
  }

  const categoryMeta = (id) => CATEGORIAS.find(c => c.id === id) || CATEGORIAS[4]
  const totalAtivos = items.filter(t => t.is_active !== false).length
  const totalArquivados = items.length - totalAtivos

  return (
    <div className="flex-1 flex flex-col gap-4 p-5 overflow-auto" style={{ color: 'var(--ao-text)' }}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileText size={22} />
            Templates de mensagem
          </h1>
          <p className="text-sm opacity-70 mt-1">
            {totalAtivos} ativo{totalAtivos !== 1 ? 's' : ''}
            {totalArquivados > 0 && ` · ${totalArquivados} arquivado${totalArquivados !== 1 ? 's' : ''}`}
            {' · usado no Atendimento WhatsApp'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            title="Recarregar"
            style={{
              padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--ao-border)', background: 'transparent',
              color: 'var(--ao-text-secondary)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
            }}
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={openNew}
            style={{
              padding: '8px 14px', borderRadius: 8, border: 'none',
              background: 'linear-gradient(135deg, #C4956A, #A67B52)',
              color: '#fff', cursor: 'pointer', fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13,
            }}
          >
            <Plus size={14} />
            Novo template
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <div style={{ position: 'relative', minWidth: 220 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: 10, opacity: 0.5 }} />
          <input
            type="text"
            value={filterQ}
            onChange={e => setFilterQ(e.target.value)}
            placeholder="Buscar por nome ou conteúdo..."
            style={{
              width: '100%', padding: '8px 10px 8px 30px', fontSize: 12.5, borderRadius: 8,
              border: '1px solid var(--ao-border)',
              background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button
            onClick={() => setFilterCat('')}
            style={{
              padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6,
              border: '1px solid var(--ao-border)',
              background: !filterCat ? 'var(--ao-surface)' : 'transparent',
              color: 'var(--ao-text-primary)', cursor: 'pointer',
            }}
          >
            Todas ({items.filter(t => t.is_active !== false).length})
          </button>
          {CATEGORIAS.map(c => {
            const n = items.filter(t => t.is_active !== false && t.category === c.id).length
            return (
              <button
                key={c.id}
                onClick={() => setFilterCat(filterCat === c.id ? '' : c.id)}
                style={{
                  padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6,
                  border: `1px solid ${filterCat === c.id ? c.color + '88' : 'var(--ao-border)'}`,
                  background: filterCat === c.id ? c.color + '20' : 'transparent',
                  color: filterCat === c.id ? c.color : 'var(--ao-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {c.label} {n > 0 && `(${n})`}
              </button>
            )
          })}
        </div>
        <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--ao-text-dim)' }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={e => setShowArchived(e.target.checked)}
          />
          Mostrar arquivados
        </label>
      </div>

      {/* Erro */}
      {error && (
        <div style={{ padding: 10, borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', fontSize: 12 }}>
          Erro: {error}
        </div>
      )}

      {/* Lista */}
      {loading && !items.length && (
        <div style={{ textAlign: 'center', padding: 30, opacity: 0.5 }}>
          <Loader2 size={20} className="animate-spin" />
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', opacity: 0.4, fontSize: 13, border: '1px dashed var(--ao-border)', borderRadius: 8 }}>
          {filterCat || filterQ ? 'Nenhum template casa com os filtros.' : 'Nenhum template ainda. Clique em "+ Novo template".'}
        </div>
      )}
      {filtered.map(t => {
        const cat = categoryMeta(t.category)
        const archived = t.is_active === false
        return (
          <div
            key={t.id}
            style={{
              padding: 14, borderRadius: 10,
              border: '1px solid var(--ao-border)',
              background: 'var(--ao-card)',
              opacity: archived ? 0.55 : 1,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
              <span style={{
                fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                background: cat.color + '22', color: cat.color, textTransform: 'uppercase', letterSpacing: '0.5px',
                flexShrink: 0,
              }}>
                {cat.label}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {t.name}
                  {archived && <span style={{ fontSize: 10, marginLeft: 8, opacity: 0.7, fontStyle: 'italic' }}>(arquivado)</span>}
                </div>
                {t.usage_count > 0 && (
                  <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)', marginTop: 2 }}>
                    Usado {t.usage_count} vez{t.usage_count !== 1 ? 'es' : ''}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button
                  onClick={() => duplicate(t)}
                  title="Duplicar"
                  style={btnIconStyle}
                >
                  <Copy size={12} />
                </button>
                <button
                  onClick={() => openEdit(t)}
                  title="Editar"
                  style={btnIconStyle}
                >
                  <Edit2 size={12} />
                </button>
                {archived ? (
                  <button onClick={() => unarchive(t)} title="Restaurar" style={{ ...btnIconStyle, color: '#10B981' }}>
                    <RefreshCw size={12} />
                  </button>
                ) : (
                  <button onClick={() => archive(t)} title="Arquivar" style={{ ...btnIconStyle, color: '#EF4444' }}>
                    <Archive size={12} />
                  </button>
                )}
              </div>
            </div>
            <pre style={{
              fontSize: 12, lineHeight: 1.5, margin: 0, padding: 10,
              background: 'var(--ao-bg)', borderRadius: 6,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontFamily: 'inherit', color: 'var(--ao-text-secondary)',
            }}>
              {t.body}
            </pre>
          </div>
        )
      })}

      {/* Modal editor */}
      {editing && (
        <div
          onClick={close}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 12,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto',
              background: 'var(--ao-card)', borderRadius: 14,
              border: '1px solid var(--ao-border)',
              color: 'var(--ao-text-primary)',
            }}
          >
            <div style={{
              padding: '14px 18px', borderBottom: '1px solid var(--ao-border)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, flex: 1 }}>
                {editing === 'new' ? 'Novo template' : `Editar: ${editing.name}`}
              </h3>
              <button onClick={close} style={{ background: 'transparent', border: 'none', color: 'var(--ao-text-dim)', cursor: 'pointer' }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelStyle}>Nome</label>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="ex: Confirmação NFS-e emitida"
                  maxLength={120}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Categoria</label>
                <select
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  style={inputStyle}
                >
                  {CATEGORIAS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>

              <div>
                <label style={labelStyle}>Mensagem</label>
                <textarea
                  value={form.body}
                  onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                  placeholder="Olá {nome}, sua NFS-e foi emitida. Número: {numero}, Valor: R$ {valor}"
                  rows={8}
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 140, fontFamily: 'inherit' }}
                />
              </div>

              <div style={{ padding: 10, borderRadius: 8, background: 'var(--ao-surface)', fontSize: 11 }}>
                <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--ao-text-primary)' }}>
                  Variáveis disponíveis (clique pra inserir):
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {VARIAVEIS_DISPONIVEIS.map(v => (
                    <button
                      key={v.key}
                      onClick={() => setForm(f => ({ ...f, body: f.body + v.key }))}
                      title={v.desc}
                      style={{
                        padding: '3px 8px', fontSize: 11, borderRadius: 5,
                        border: '1px solid var(--ao-border)',
                        background: 'var(--ao-bg)',
                        color: 'var(--ao-text-primary)',
                        cursor: 'pointer',
                        fontFamily: 'monospace',
                      }}
                    >
                      {v.key}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{
              padding: '10px 16px', borderTop: '1px solid var(--ao-border)',
              display: 'flex', justifyContent: 'flex-end', gap: 8,
            }}>
              <button
                onClick={close}
                disabled={saving}
                style={{
                  padding: '8px 14px', fontSize: 12, fontWeight: 600, borderRadius: 7,
                  border: '1px solid var(--ao-border)', background: 'transparent',
                  color: 'var(--ao-text-secondary)', cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={saving}
                style={{
                  padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 7,
                  border: 'none',
                  background: 'linear-gradient(135deg, #C4956A, #A67B52)',
                  color: '#fff', cursor: saving ? 'wait' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                }}
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const labelStyle = {
  fontSize: 10, fontWeight: 700, opacity: 0.7,
  textTransform: 'uppercase', letterSpacing: '0.4px',
  display: 'block', marginBottom: 5,
}
const inputStyle = {
  width: '100%', padding: '8px 12px', fontSize: 13, borderRadius: 7,
  border: '1px solid var(--ao-border)',
  background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
  fontFamily: 'inherit',
}
const btnIconStyle = {
  width: 28, height: 28, borderRadius: 6,
  border: '1px solid var(--ao-border)', background: 'transparent',
  color: 'var(--ao-text-dim)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
}
