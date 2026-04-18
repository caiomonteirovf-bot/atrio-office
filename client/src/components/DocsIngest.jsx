import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FileText, Image as ImageIcon, FileSpreadsheet, FileType, Upload, Check, X, Loader2, RefreshCw, AlertCircle, Eye, BarChart3, Users, Trash2 } from 'lucide-react'

/**
 * Aba Documentos — upload, revisão e auditoria de RAG.
 *
 * Abas:
 *   - Upload: drag-drop com seleção de cliente
 *   - Pendentes: revisa drafts; aprovar ou rejeitar em lote
 *   - Auditoria: estatísticas de uso do RAG (top hits, por agente, por cliente)
 */
export default function DocsIngest() {
  const [tab, setTab] = useState('upload')
  const [clients, setClients] = useState([])
  const [selectedClient, setSelectedClient] = useState('')

  useEffect(() => {
    fetch('/api/datalake/clientes?limit=500')
      .then(r => r.json())
      .then(d => setClients(Array.isArray(d.rows) ? d.rows : []))
      .catch(() => {})
  }, [])

  return (
    <div className="flex-1 flex flex-col gap-4 p-4 overflow-auto" style={{ color: 'var(--ao-text)' }}>
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Documentos</h1>
          <p className="text-sm opacity-70">PDF, DOCX, XLSX e imagens viram memória vetorizada que os agentes consultam</p>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b" style={{ borderColor: 'var(--ao-border)' }}>
        {[
          { id: 'upload',   label: 'Enviar',        icon: Upload },
          { id: 'pending',  label: 'Pendentes',     icon: FileText },
          { id: 'audit',    label: 'Auditoria RAG', icon: BarChart3 },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className="flex items-center gap-2 px-4 py-2 text-sm transition-colors"
            style={{
              borderBottom: tab === t.id ? `2px solid var(--ao-accent)` : '2px solid transparent',
              color: tab === t.id ? 'var(--ao-text)' : 'var(--ao-muted)',
              fontWeight: tab === t.id ? 600 : 400,
            }}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'upload'  && <UploadTab clients={clients} selectedClient={selectedClient} setSelectedClient={setSelectedClient} />}
      {tab === 'pending' && <PendingTab clients={clients} />}
      {tab === 'audit'   && <AuditTab clients={clients} />}
    </div>
  )
}

// ============================================================
// UPLOAD TAB
// ============================================================
function UploadTab({ clients, selectedClient, setSelectedClient }) {
  const [uploading, setUploading] = useState(false)
  const [lastResult, setLastResult] = useState(null)
  const [error, setError] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef(null)

  const handleFile = async (file) => {
    if (!file) return
    setUploading(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (selectedClient) fd.append('client_id', selectedClient)
      const r = await fetch('/api/ingest', { method: 'POST', body: fd })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`)
      setLastResult(d)
    } catch (e) { setError(e.message) }
    finally { setUploading(false) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-sm">
        <label className="opacity-70">Vincular a cliente (opcional):</label>
        <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)}
          className="px-3 py-1.5 rounded border text-sm" style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }}>
          <option value="">— Nenhum (documento interno) —</option>
          {clients.map(c => (
            <option key={c.gesthub_id} value={c.gesthub_id}>
              {c.razao_social || c.nome_fantasia} {c.cnpj ? `(${c.cnpj})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f) }}
        onClick={() => fileInputRef.current?.click()}
        className="rounded-xl p-8 text-center cursor-pointer transition-all"
        style={{
          border: `2px dashed ${dragActive ? 'var(--ao-accent)' : 'var(--ao-border)'}`,
          background: dragActive ? 'color-mix(in oklab, var(--ao-accent) 8%, transparent)' : 'var(--ao-surface)',
        }}
      >
        <input ref={fileInputRef} type="file" accept="application/pdf,image/*,.docx,.xlsx"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} className="hidden" />
        {uploading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="animate-spin" size={32} />
            <p className="text-sm">Processando...</p>
            <p className="text-xs opacity-60">PDF/DOCX/XLSX: extração + chunking + embeddings. Imagem: Claude Vision.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Upload size={32} style={{ opacity: 0.5 }} />
            <p className="text-sm font-medium">Arraste aqui ou clique</p>
            <p className="text-xs opacity-60">PDF · DOCX · XLSX · Imagem (máx 25 MB)</p>
          </div>
        )}
      </div>

      {lastResult && <ResultBanner result={lastResult} onDismiss={() => setLastResult(null)} />}
      {error && <ErrorBanner msg={error} onDismiss={() => setError(null)} />}
    </div>
  )
}

// ============================================================
// PENDING TAB
// ============================================================
function PendingTab({ clients }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [filters, setFilters] = useState({ client_id: '', doc_type: '', q: '', status: 'draft' })
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()
      const r = await fetch('/api/ingest/pending?' + qs)
      const d = await r.json()
      setItems(d.data || [])
      setSelectedIds(new Set())
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [filters])

  useEffect(() => { load() }, [load])

  const batch = async (endpoint) => {
    if (!selectedIds.size) return
    try {
      const r = await fetch(`/api/ingest/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memory_ids: Array.from(selectedIds) }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.error || 'falha')
      await load()
    } catch (e) { setError(e.message) }
  }

  const toggle = (id) => setSelectedIds(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n
  })
  const selectAll = () => setSelectedIds(selectedIds.size === items.length ? new Set() : new Set(items.map(i => i.id)))

  const iconFor = (t) => {
    if (t === 'pdf') return <FileText size={14} />
    if (t === 'docx') return <FileType size={14} />
    if (t === 'xlsx') return <FileSpreadsheet size={14} />
    return <ImageIcon size={14} />
  }
  const clientName = (gid) => {
    if (!gid) return '—'
    const c = clients.find(x => String(x.gesthub_id) === String(gid))
    return c ? (c.razao_social || c.nome_fantasia) : `#${gid}`
  }
  const fmtDate = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex-1 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={filters.client_id} onChange={e => setFilters({ ...filters, client_id: e.target.value })}
          className="px-2 py-1 rounded border text-xs" style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }}>
          <option value="">Todos clientes</option>
          {clients.map(c => <option key={c.gesthub_id} value={c.gesthub_id}>{c.razao_social || c.nome_fantasia}</option>)}
        </select>
        <select value={filters.doc_type} onChange={e => setFilters({ ...filters, doc_type: e.target.value })}
          className="px-2 py-1 rounded border text-xs" style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }}>
          <option value="">Todos tipos</option>
          <option value="pdf">PDF</option><option value="docx">DOCX</option><option value="xlsx">XLSX</option>
          <option value="boleto">Boleto</option><option value="comprovante">Comprovante</option>
          <option value="nota_fiscal">Nota fiscal</option><option value="contrato">Contrato</option>
          <option value="extrato">Extrato</option><option value="documento_pessoal">Doc pessoal</option>
          <option value="foto">Foto</option>
        </select>
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}
          className="px-2 py-1 rounded border text-xs" style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }}>
          <option value="draft">Pendentes</option>
          <option value="approved">Aprovados</option>
          <option value="rejected">Rejeitados</option>
          <option value="draft,approved,rejected">Todos</option>
        </select>
        <input value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} placeholder="buscar..."
          className="px-2 py-1 rounded border text-xs flex-1 min-w-[200px]" style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }} />
        <button onClick={load} className="flex items-center gap-1 px-2 py-1 rounded text-xs" style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
          <RefreshCw size={12} /> Atualizar
        </button>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs opacity-70">{items.length} item(s)</span>
        <div className="flex items-center gap-2">
          <button onClick={selectAll} className="text-xs px-2 py-1 rounded" style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
            {selectedIds.size === items.length && items.length > 0 ? 'Limpar' : 'Selecionar todos'}
          </button>
          <button onClick={() => batch('approve')} disabled={!selectedIds.size}
            className="text-xs px-3 py-1 rounded flex items-center gap-1 disabled:opacity-40"
            style={{ background: 'var(--ao-accent)', color: 'white' }}>
            <Check size={12} /> Aprovar ({selectedIds.size})
          </button>
          <button onClick={() => batch('reject')} disabled={!selectedIds.size}
            className="text-xs px-3 py-1 rounded flex items-center gap-1 disabled:opacity-40"
            style={{ background: 'color-mix(in oklab, red 60%, var(--ao-surface))', color: 'white' }}>
            <Trash2 size={12} /> Rejeitar ({selectedIds.size})
          </button>
        </div>
      </div>

      {error && <ErrorBanner msg={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <div className="flex items-center justify-center py-8 opacity-60"><Loader2 className="animate-spin" size={20} /></div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center opacity-60 text-sm">Nenhum item com esse filtro.</div>
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--ao-border)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--ao-surface)' }}>
              <tr>
                <th className="w-8 p-2"></th>
                <th className="text-left p-2">Tipo</th>
                <th className="text-left p-2">Título</th>
                <th className="text-left p-2">Cliente</th>
                <th className="text-left p-2 w-16">Pags</th>
                <th className="text-left p-2 w-20">Conf.</th>
                <th className="text-left p-2 w-28">Criado</th>
                <th className="w-12 p-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => (
                <tr key={p.id} className="border-t cursor-pointer hover:opacity-90" style={{ borderColor: 'var(--ao-border)' }}
                  onClick={() => toggle(p.id)}>
                  <td className="p-2"><input type="checkbox" checked={selectedIds.has(p.id)} readOnly /></td>
                  <td className="p-2"><span className="inline-flex items-center gap-1">{iconFor(p.document_type)}<span className="text-xs opacity-70">{p.document_type}</span></span></td>
                  <td className="p-2 max-w-[280px] truncate" title={p.title}>{p.title}</td>
                  <td className="p-2 text-xs truncate max-w-[220px]" title={clientName(p.gesthub_client_id)}>{clientName(p.gesthub_client_id)}</td>
                  <td className="p-2 text-xs">{p.pages || '—'}</td>
                  <td className="p-2 text-xs">{p.confidence_score != null ? `${Math.round(p.confidence_score * 100)}%` : '—'}</td>
                  <td className="p-2 text-xs opacity-70">{fmtDate(p.created_at)}</td>
                  <td className="p-2" onClick={e => e.stopPropagation()}>
                    {p.file_path && (
                      <button onClick={() => setPreview(p)} className="opacity-60 hover:opacity-100" title="Ver original"><Eye size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

// ============================================================
// AUDIT TAB
// ============================================================
function AuditTab({ clients }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/api/memory/usage-stats')
      .then(r => r.json())
      .then(d => setStats(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex items-center justify-center py-10 opacity-60"><Loader2 className="animate-spin" /></div>
  if (error) return <ErrorBanner msg={error} />
  if (!stats) return null

  const clientName = (gid) => {
    if (!gid) return '—'
    const c = clients.find(x => String(x.gesthub_id) === String(gid))
    return c ? (c.razao_social || c.nome_fantasia) : `#${gid}`
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card title="Top 20 memórias mais consultadas" icon={BarChart3}>
        {stats.top_hits?.length ? (
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--ao-surface)' }}>
              <tr><th className="text-left p-1.5">Título</th><th className="text-left p-1.5 w-16">Tipo</th><th className="text-right p-1.5 w-14">Hits</th></tr>
            </thead>
            <tbody>
              {stats.top_hits.map(m => (
                <tr key={m.id} className="border-t" style={{ borderColor: 'var(--ao-border)' }}>
                  <td className="p-1.5 truncate max-w-[260px]" title={m.title}>{m.title}</td>
                  <td className="p-1.5 opacity-60">{m.doc_type || 'texto'}</td>
                  <td className="p-1.5 text-right">{m.semantic_hits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="text-xs opacity-60 p-3">Nenhum hit registrado ainda.</div>}
      </Card>

      <Card title="Consumo por agente" icon={Users}>
        <table className="w-full text-xs">
          <thead style={{ background: 'var(--ao-surface)' }}>
            <tr><th className="text-left p-1.5">Agente</th><th className="text-right p-1.5">Aprov.</th><th className="text-right p-1.5">Draft</th><th className="text-right p-1.5">Hits</th></tr>
          </thead>
          <tbody>
            {stats.by_agent.map(r => (
              <tr key={r.agent} className="border-t" style={{ borderColor: 'var(--ao-border)' }}>
                <td className="p-1.5">{r.agent || '—'}</td>
                <td className="p-1.5 text-right">{r.approved}</td>
                <td className="p-1.5 text-right opacity-60">{r.draft}</td>
                <td className="p-1.5 text-right font-medium">{r.total_hits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Por cliente" icon={Users} className="md:col-span-2">
        {stats.by_client?.length ? (
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--ao-surface)' }}>
              <tr><th className="text-left p-1.5">Cliente</th><th className="text-right p-1.5 w-20">Total</th><th className="text-right p-1.5 w-20">Hits</th></tr>
            </thead>
            <tbody>
              {stats.by_client.map(r => (
                <tr key={r.client_id} className="border-t" style={{ borderColor: 'var(--ao-border)' }}>
                  <td className="p-1.5">{clientName(r.client_id)}</td>
                  <td className="p-1.5 text-right">{r.total}</td>
                  <td className="p-1.5 text-right font-medium">{r.hits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="text-xs opacity-60 p-3">Nenhuma memória vinculada a cliente.</div>}
      </Card>

      <Card title="Por tipo / status" icon={FileText} className="md:col-span-2">
        <table className="w-full text-xs">
          <thead style={{ background: 'var(--ao-surface)' }}>
            <tr><th className="text-left p-1.5">Tipo</th><th className="text-left p-1.5">Status</th><th className="text-right p-1.5 w-20">Total</th></tr>
          </thead>
          <tbody>
            {stats.by_type.map((r, i) => (
              <tr key={i} className="border-t" style={{ borderColor: 'var(--ao-border)' }}>
                <td className="p-1.5">{r.doc_type}</td>
                <td className="p-1.5 opacity-70">{r.status}</td>
                <td className="p-1.5 text-right">{r.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

// ============================================================
// SHARED
// ============================================================
function Card({ title, icon: Icon, children, className = '' }) {
  return (
    <div className={`rounded-lg ${className}`} style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
      <div className="flex items-center gap-2 px-3 py-2 border-b text-sm font-medium" style={{ borderColor: 'var(--ao-border)' }}>
        {Icon && <Icon size={14} />} {title}
      </div>
      <div className="p-1">{children}</div>
    </div>
  )
}

function ResultBanner({ result, onDismiss }) {
  return (
    <div className="rounded-lg p-3 text-sm flex items-start gap-3"
      style={{ background: 'color-mix(in oklab, green 10%, var(--ao-surface))', border: '1px solid color-mix(in oklab, green 30%, var(--ao-border))' }}>
      <Check size={18} className="mt-0.5" style={{ color: 'rgb(34 197 94)' }} />
      <div className="flex-1">
        <div className="font-medium">
          {result.type === 'image'
            ? `Imagem ingerida — ${result.doc_type} (${Math.round((result.confidence || 0) * 100)}%)`
            : `${result.type?.toUpperCase()} ingerido — ${result.chunks} chunk(s), ${result.pages || '?'} página(s)/sheet(s)`}
        </div>
        {result.structured && (
          <pre className="text-xs mt-1 opacity-80 overflow-x-auto">{JSON.stringify(result.structured, null, 2)}</pre>
        )}
        {result.preview && <div className="text-xs mt-1 opacity-70 line-clamp-2">{result.preview}</div>}
      </div>
      <button onClick={onDismiss} className="text-xs opacity-60 hover:opacity-100">dispensar</button>
    </div>
  )
}

function ErrorBanner({ msg, onDismiss }) {
  return (
    <div className="rounded-lg p-3 text-sm flex items-start gap-3"
      style={{ background: 'color-mix(in oklab, red 10%, var(--ao-surface))', border: '1px solid color-mix(in oklab, red 30%, var(--ao-border))' }}>
      <AlertCircle size={18} className="mt-0.5" style={{ color: 'rgb(239 68 68)' }} />
      <div className="flex-1">{msg}</div>
      {onDismiss && <button onClick={onDismiss} className="text-xs opacity-60 hover:opacity-100">✕</button>}
    </div>
  )
}

function PreviewModal({ item, onClose }) {
  const isImg = ['boleto','comprovante','nota_fiscal','foto','documento_pessoal'].includes(item.document_type) || item.filename?.match(/\.(png|jpe?g|webp|gif)$/i)
  const isPdf = item.document_type === 'pdf' || item.filename?.toLowerCase().endsWith('.pdf')
  const inlineUrl = `/api/ingest/file/${item.id}`

  return (
    <div onClick={onClose} className="fixed inset-0 z-[200] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div onClick={e => e.stopPropagation()} className="rounded-lg max-w-5xl max-h-[90vh] w-full overflow-hidden flex flex-col"
        style={{ background: 'var(--ao-bg)', border: '1px solid var(--ao-border)' }}>
        <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--ao-border)' }}>
          <div className="text-sm font-medium truncate">{item.title}</div>
          <div className="flex items-center gap-2">
            <a href={inlineUrl} target="_blank" rel="noopener" className="text-xs opacity-70 hover:opacity-100">Abrir em nova aba</a>
            <button onClick={onClose} className="opacity-60 hover:opacity-100"><X size={16} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto" style={{ background: 'var(--ao-surface)' }}>
          {isImg ? (
            <img src={inlineUrl} alt={item.title} className="mx-auto max-w-full max-h-[80vh] object-contain" />
          ) : isPdf ? (
            <iframe src={inlineUrl} title={item.title} className="w-full" style={{ height: '80vh', border: 0 }} />
          ) : (
            <div className="p-4 text-sm">
              <p className="opacity-70 mb-3">Preview inline não disponível para este tipo.</p>
              <a href={inlineUrl} className="text-sm underline" style={{ color: 'var(--ao-accent)' }}>Baixar {item.filename}</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
