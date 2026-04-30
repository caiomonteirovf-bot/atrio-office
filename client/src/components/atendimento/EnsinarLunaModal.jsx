import { useState } from 'react'
import { Sparkles, X, Loader2, Check } from 'lucide-react'
import { ensinarLuna } from './atendimento-api'

/**
 * Modal pra ensinar Luna uma regra nova a partir de uma conversa real.
 *
 * Props:
 *  - open: bool
 *  - onClose: fn
 *  - conversation: {id, phone, client_name, ...}  — contexto pre-preenchido
 *  - seedContent: string (opcional — texto inicial, ex: ultima msg + resposta ideal)
 */
export default function EnsinarLunaModal({ open, onClose, conversation: conv, seedContent = '' }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState(seedContent)
  const [category, setCategory] = useState('process_rule')
  const [scope, setScope] = useState('cliente')  // cliente | assunto | comportamento | geral
  const [assunto, setAssunto] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  if (!open) return null

  const canSave = title.trim().length >= 5 && content.trim().length >= 10 && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      // Monta tags
      const tags = ['ensinado-via-atendimento']
      if (scope === 'cliente' && conv?.client_name) {
        tags.push(`cliente:${String(conv.client_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`)
      }
      if (assunto.trim()) {
        tags.push(`assunto:${assunto.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`)
      }
      if (scope === 'comportamento') tags.push('tipo:comportamento')
      if (scope === 'geral') tags.push('escopo:global')

      await ensinarLuna({
        title: title.trim(),
        content: content.trim(),
        tags,
        category,
        scope_context: {
          cliente_nome: conv?.client_name,
          phone: conv?.phone,
          conversation_id: conv?.id,
        },
      })
      setDone(true)
      setTimeout(() => { onClose?.(); setDone(false); setTitle(''); setContent(''); setAssunto('') }, 1100)
    } catch (e) {
      setError(e.message)
    } finally { setSaving(false) }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 12,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto',
          background: 'var(--ao-card)', borderRadius: 12,
          border: '1px solid var(--ao-border)',
          padding: 18, color: 'var(--ao-text-primary)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #BA7517, #A67B52)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Sparkles size={16} color="#fff" />
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Ensinar Luna</h3>
            <p style={{ fontSize: 11, margin: 0, color: 'var(--ao-text-dim)' }}>
              Nova regra vai direto pro RAG dela.
              {conv?.client_name && <> Contexto: <strong>{conv.client_name}</strong></>}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--ao-text-dim)', cursor: 'pointer', padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        {done && (
          <div style={{
            padding: 10, marginBottom: 12, borderRadius: 8,
            background: 'rgba(16, 185, 129, 0.12)', border: '1px solid rgba(16, 185, 129, 0.3)',
            color: '#10B981', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Check size={14} /> Memória gravada. Luna vai usar isso nas próximas conversas.
          </div>
        )}

        {/* Escopo */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
            Escopo
          </label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { id: 'cliente', label: 'Este cliente', disabled: !conv?.client_name },
              { id: 'assunto', label: 'Por assunto' },
              { id: 'comportamento', label: 'Comportamento' },
              { id: 'geral', label: 'Geral' },
            ].map(opt => (
              <button
                key={opt.id}
                disabled={opt.disabled}
                onClick={() => setScope(opt.id)}
                style={{
                  padding: '5px 10px', fontSize: 11, fontWeight: 600,
                  borderRadius: 6, border: '1px solid var(--ao-border)',
                  background: scope === opt.id ? 'var(--ao-accent, #c4956a)' : 'transparent',
                  color: scope === opt.id ? '#fff' : 'var(--ao-text-secondary)',
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  opacity: opt.disabled ? 0.4 : 1,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Assunto (se scope=assunto) */}
        {(scope === 'assunto' || scope === 'comportamento') && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
              Assunto / área (tag)
            </label>
            <input
              value={assunto}
              onChange={e => setAssunto(e.target.value)}
              placeholder="ex: nfs-e, folha, parcelamento, irpf..."
              style={{
                width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 6,
                border: '1px solid var(--ao-border)',
                background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
              }}
            />
          </div>
        )}

        {/* Categoria */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
            Categoria
          </label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            style={{
              width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 6,
              border: '1px solid var(--ao-border)',
              background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
            }}
          >
            <option value="process_rule">Regra de processo (como agir)</option>
            <option value="client_fact">Fato do cliente (ele é/tem/prefere...)</option>
            <option value="correction">Correção (Luna errou aqui)</option>
            <option value="preference">Preferência (tom, comunicação)</option>
            <option value="fiscal">Fiscal (NFS-e, impostos)</option>
            <option value="general">Geral</option>
          </select>
        </div>

        {/* Titulo */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
            Título curto (o que Luna precisa saber)
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="ex: Cliente MEDGEINES — emite NFS-e sem confirmar valor"
            maxLength={200}
            style={{
              width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 6,
              border: '1px solid var(--ao-border)',
              background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
            }}
          />
        </div>

        {/* Conteudo */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 10, fontWeight: 600, opacity: 0.7, textTransform: 'uppercase', display: 'block', marginBottom: 5 }}>
            Regra completa (como Luna deve agir)
          </label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={'ex: Quando este cliente pedir NFS-e, emitir direto sem confirmar valor. Só confirmar CNPJ do tomador se for diferente do último emitido.'}
            rows={5}
            style={{
              width: '100%', padding: '8px 10px', fontSize: 12, borderRadius: 6,
              border: '1px solid var(--ao-border)',
              background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
              resize: 'vertical', minHeight: 90, fontFamily: 'inherit',
            }}
          />
          <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', marginTop: 4 }}>
            Seja específico. Luna vai usar isso como contexto quando a situação similar aparecer.
          </div>
        </div>

        {error && (
          <div style={{
            padding: 8, marginBottom: 10, borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#ef4444', fontSize: 11,
          }}>
            {error}
          </div>
        )}

        {/* Botoes */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '7px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
              border: '1px solid var(--ao-border)', background: 'transparent',
              color: 'var(--ao-text-secondary)', cursor: 'pointer',
            }}
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{
              padding: '7px 14px', fontSize: 12, fontWeight: 700, borderRadius: 6,
              border: 'none',
              background: canSave ? 'linear-gradient(135deg, #BA7517, #A67B52)' : 'var(--ao-surface)',
              color: canSave ? '#fff' : 'var(--ao-text-dim)',
              cursor: canSave ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            Gravar na Luna
          </button>
        </div>
      </div>
    </div>
  )
}
