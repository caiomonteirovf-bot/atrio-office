import { useState, useEffect } from 'react'
import { FileText, Image as ImageIcon, FileSpreadsheet, FileType, Eye, Loader2, Check, Trash2, AlertCircle } from 'lucide-react'

/**
 * Tab de documentos de UM cliente específico.
 * Usada dentro do DatalakeViewer (detalhe de cliente).
 *
 * Props:
 *   gesthub_id — integer do cliente no Gesthub
 */
export default function ClientDocsTab({ gesthub_id }) {
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null)
  const [statusFilter, setStatusFilter] = useState('draft,approved')

  const load = async () => {
    if (!gesthub_id) return
    setLoading(true)
    try {
      const r = await fetch(`/api/ingest/pending?client_id=${gesthub_id}&status=${encodeURIComponent(statusFilter)}`)
      const d = await r.json()
      setDocs(d.data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [gesthub_id, statusFilter]) // eslint-disable-line

  const action = async (endpoint, memory_id) => {
    try {
      const r = await fetch(`/api/ingest/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memory_ids: [memory_id] }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.error || 'falha')
      await load()
    } catch (e) { setError(e.message) }
  }

  const iconFor = (t) => {
    if (t === 'pdf') return <FileText size={14} />
    if (t === 'docx') return <FileType size={14} />
    if (t === 'xlsx') return <FileSpreadsheet size={14} />
    return <ImageIcon size={14} />
  }
  const statusBadge = (s) => {
    const styles = {
      approved: { bg: 'color-mix(in oklab, green 12%, transparent)', color: 'rgb(34 197 94)' },
      draft:    { bg: 'color-mix(in oklab, orange 12%, transparent)', color: 'rgb(234 179 8)' },
      rejected: { bg: 'color-mix(in oklab, red 12%, transparent)', color: 'rgb(239 68 68)' },
    }
    const st = styles[s] || { bg: 'transparent', color: 'var(--ao-text-dim)' }
    return <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: st.bg, color: st.color }}>{s}</span>
  }
  const fmtDate = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  if (loading) return <div className="flex items-center justify-center py-6 opacity-60"><Loader2 className="animate-spin" size={18} /></div>

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-2 py-1 rounded border"
          style={{ background: 'var(--ao-surface)', borderColor: 'var(--ao-border)', color: 'var(--ao-text)' }}>
          <option value="draft,approved">Ativos (draft + approved)</option>
          <option value="draft">Apenas pendentes</option>
          <option value="approved">Apenas aprovados</option>
          <option value="rejected">Rejeitados</option>
          <option value="draft,approved,rejected">Todos</option>
        </select>
        <span className="opacity-60">{docs.length} documento(s)</span>
      </div>

      {error && (
        <div className="rounded p-2 text-xs flex items-center gap-2" style={{ background: 'color-mix(in oklab, red 10%, transparent)', color: 'rgb(239 68 68)' }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {docs.length === 0 ? (
        <div className="py-6 text-center opacity-60 text-xs">
          Nenhum documento ingerido para este cliente ainda.
          <br />
          <span className="opacity-70">PDFs e imagens enviados no WhatsApp aparecem aqui automaticamente.</span>
        </div>
      ) : (
        <div className="rounded overflow-hidden" style={{ border: '1px solid var(--ao-border)' }}>
          <table className="w-full text-[12px]">
            <thead style={{ background: 'var(--ao-surface)' }}>
              <tr>
                <th className="text-left p-2">Tipo</th>
                <th className="text-left p-2">Título</th>
                <th className="text-left p-2 w-20">Status</th>
                <th className="text-left p-2 w-28">Criado</th>
                <th className="w-28 p-2"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map(d => (
                <tr key={d.id} className="border-t" style={{ borderColor: 'var(--ao-border)' }}>
                  <td className="p-2"><span className="inline-flex items-center gap-1">{iconFor(d.document_type)}<span className="text-[10px] opacity-70">{d.document_type}</span></span></td>
                  <td className="p-2 max-w-[320px] truncate" title={d.title}>{d.title}</td>
                  <td className="p-2">{statusBadge(d.status)}</td>
                  <td className="p-2 text-[11px] opacity-70">{fmtDate(d.created_at)}</td>
                  <td className="p-2 text-right">
                    <div className="inline-flex gap-1">
                      {d.file_path && (
                        <button onClick={() => setPreview(d)} className="opacity-60 hover:opacity-100" title="Ver"><Eye size={13} /></button>
                      )}
                      {d.status === 'draft' && (
                        <>
                          <button onClick={() => action('approve', d.id)} className="opacity-70 hover:opacity-100" title="Aprovar" style={{ color: 'rgb(34 197 94)' }}><Check size={13} /></button>
                          <button onClick={() => action('reject', d.id)} className="opacity-70 hover:opacity-100" title="Rejeitar" style={{ color: 'rgb(239 68 68)' }}><Trash2 size={13} /></button>
                        </>
                      )}
                    </div>
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

function PreviewModal({ item, onClose }) {
  const isImg = ['boleto','comprovante','nota_fiscal','foto','documento_pessoal','extrato'].includes(item.document_type) || item.filename?.match(/\.(png|jpe?g|webp|gif)$/i)
  const isPdf = item.document_type === 'pdf' || item.filename?.toLowerCase().endsWith('.pdf')
  const inlineUrl = `/api/ingest/file/${item.id}`
  return (
    <div onClick={onClose} className="fixed inset-0 z-[200] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div onClick={e => e.stopPropagation()} className="rounded-lg max-w-5xl max-h-[90vh] w-full overflow-hidden flex flex-col"
        style={{ background: 'var(--ao-bg)', border: '1px solid var(--ao-border)' }}>
        <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: 'var(--ao-border)' }}>
          <div className="text-sm font-medium truncate">{item.title}</div>
          <div className="flex items-center gap-2">
            <a href={inlineUrl} target="_blank" rel="noopener" className="text-xs opacity-70 hover:opacity-100">Nova aba</a>
            <button onClick={onClose} className="opacity-60 hover:opacity-100">✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto" style={{ background: 'var(--ao-surface)' }}>
          {isImg ? <img src={inlineUrl} alt={item.title} className="mx-auto max-w-full max-h-[80vh] object-contain" />
          : isPdf ? <iframe src={inlineUrl} title={item.title} className="w-full" style={{ height: '80vh', border: 0 }} />
          : <div className="p-4 text-sm"><a href={inlineUrl} className="underline" style={{ color: 'var(--ao-accent)' }}>Baixar {item.filename}</a></div>}
        </div>
      </div>
    </div>
  )
}
