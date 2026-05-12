import { useState, useEffect, useRef } from 'react'
import { Search, X, Loader2, Link2, ExternalLink } from 'lucide-react'
import { searchGesthubClients, linkConversationToClient } from './atendimento-api'

/**
 * Modal pra buscar cliente na Carteira do Gesthub e vincular à conversa.
 * Alternativa: abre o Gesthub em nova aba pra cadastrar (link externo).
 *
 * Props:
 *  - open, onClose
 *  - conversation: {id, phone, client_name, display_phone}
 *  - onLinked(): callback apos sucesso
 */
export default function LinkClientModal({ open, onClose, conversation, onLinked, mode = null }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState(null) // client_id em progresso
  const [error, setError] = useState(null)
  // Satellite mode (mode='satelite'): vincular contato como tomador/socio/financeiro de cliente já cadastrado
  const [relacao, setRelacao] = useState('tomador')
  const [contatoFuncao, setContatoFuncao] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setQ(conversation?.client_name || '')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open, conversation?.client_name])

  // Debounced search
  useEffect(() => {
    if (!open) return
    if (q.trim().length < 2) { setResults([]); return }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const list = await searchGesthubClients(q)
        setResults(list)
        setError(null)
      } catch (e) { setError(e.message) }
      finally { setLoading(false) }
    }, 280)
    return () => clearTimeout(t)
  }, [q, open])

  const handleLink = async (client) => {
    setLinking(client.id); setError(null)
    try {
      const opts = {}
      if (mode === 'satelite') {
        opts.relacao = relacao
        if (contatoFuncao.trim()) opts.contato_funcao = contatoFuncao.trim()
        // Em modo satélite: NÃO substitui phone primário do cliente, NÃO marca como primary
        opts.update_phone = false
        opts.set_primary = false
      }
      await linkConversationToClient(conversation.id, client.id, opts)
      onLinked?.(client)
      onClose?.()
    } catch (e) { setError(e.message) }
    finally { setLinking(null) }
  }

  if (!open) return null

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
          width: '100%', maxWidth: 540, maxHeight: '85vh',
          background: 'var(--ao-card)', borderRadius: 12,
          border: '1px solid var(--ao-border)',
          display: 'flex', flexDirection: 'column',
          color: 'var(--ao-text-primary)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--ao-border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Link2 size={16} style={{ color: 'var(--ao-accent, #6366F1)' }} />
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Vincular contato</h3>
            <p style={{ fontSize: 11, margin: '2px 0 0', color: 'var(--ao-text-dim)' }}>
              {conversation?.client_name || conversation?.display_phone || 'Conversa atual'}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--ao-text-dim)', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Busca */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--ao-border)' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: 9, opacity: 0.5 }} />
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Buscar por nome ou CNPJ..."
              style={{
                width: '100%', padding: '7px 10px 7px 30px',
                fontSize: 13, borderRadius: 6,
                border: '1px solid var(--ao-border)',
                background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
              }}
            />
          </div>
          <p style={{ fontSize: 10, color: 'var(--ao-text-dim)', margin: '6px 0 0' }}>
            Digite ao menos 2 caracteres. Busca nome legal, fantasia ou CNPJ.
          </p>
        </div>

        {/* Tipo de relação — apenas em mode=satelite */}
        {mode === 'satelite' && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--ao-border)' }}>
            <label style={{ display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--ao-text-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Tipo de relação
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6, marginBottom: 10 }}>
              {[
                ['tomador', 'Tomador', 'solicita NFS-e'],
                ['socio', 'Sócio', 'sócio/representante'],
                ['contador', 'Contador', 'contador parceiro'],
                ['financeiro', 'Financeiro', 'financeiro do cliente'],
                ['outro', 'Outro', 'relação livre'],
              ].map(([id, label, desc]) => (
                <button
                  key={id}
                  onClick={() => setRelacao(id)}
                  type="button"
                  style={{
                    padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                    border: `1px solid ${relacao === id ? 'var(--ao-accent, #6366F1)' : 'var(--ao-border)'}`,
                    background: relacao === id ? 'rgba(99, 102, 241, 0.12)' : 'var(--ao-bg)',
                    color: relacao === id ? 'var(--ao-text-primary)' : 'var(--ao-text-secondary)',
                    fontSize: 11, fontWeight: 600, textAlign: 'left',
                    display: 'flex', flexDirection: 'column', gap: 1,
                  }}
                >
                  <span>{label}</span>
                  <span style={{ fontSize: 9, color: 'var(--ao-text-dim)', fontWeight: 400 }}>{desc}</span>
                </button>
              ))}
            </div>
            <label style={{ display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--ao-text-dim)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Nome / função do contato (opcional)
            </label>
            <input
              type="text"
              value={contatoFuncao}
              onChange={(e) => setContatoFuncao(e.target.value)}
              placeholder="ex: Andrena — Faturamento Grupo Gera"
              style={{
                width: '100%', padding: '7px 10px', borderRadius: 6,
                border: '1px solid var(--ao-border)', background: 'var(--ao-bg)',
                color: 'var(--ao-text-primary)', fontSize: 12,
              }}
            />
          </div>
        )}

        {/* Resultados */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: 20, opacity: 0.5 }}>
              <Loader2 size={14} className="animate-spin" />
            </div>
          )}
          {error && <div style={{ padding: 10, fontSize: 11, color: '#ef4444' }}>Erro: {error}</div>}
          {!loading && q.trim().length >= 2 && results.length === 0 && (
            <div style={{ textAlign: 'center', padding: 20, opacity: 0.4, fontSize: 12 }}>
              Nenhum cliente encontrado com "{q}"
            </div>
          )}
          {results.map(c => (
            <button
              key={c.id}
              onClick={() => handleLink(c)}
              disabled={!!linking}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', textAlign: 'left', cursor: linking === c.id ? 'wait' : 'pointer',
                padding: '8px 10px', marginBottom: 4, borderRadius: 6,
                border: '1px solid var(--ao-border)', background: 'var(--ao-bg)',
                color: 'var(--ao-text-primary)',
                opacity: linking && linking !== c.id ? 0.5 : 1,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: '50%',
                background: c.status === 'ATIVO' ? 'linear-gradient(135deg, #10B981, #059669)' : 'linear-gradient(135deg, #64748b, #475569)',
                color: '#fff', fontSize: 11, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {(c.legalName || c.tradeName || '?').slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.legalName || c.tradeName}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)', display: 'flex', gap: 8 }}>
                  <span>{c.document}</span>
                  {c.status && <span>· {c.status}</span>}
                  {c.city && <span>· {c.city}/{c.state}</span>}
                </div>
              </div>
              {linking === c.id && <Loader2 size={14} className="animate-spin" />}
            </button>
          ))}
        </div>

        {/* Footer — ação alternativa: criar no Gesthub */}
        <div style={{
          padding: '10px 16px', borderTop: '1px solid var(--ao-border)',
          background: 'var(--ao-surface)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 11, color: 'var(--ao-text-dim)' }}>
            Cliente novo? Cadastre primeiro no Gesthub.
          </span>
          <a
            href="http://31.97.175.200"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 5,
              background: 'var(--ao-accent, #6366F1)', color: '#fff',
              textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <ExternalLink size={11} />
            Abrir Gesthub
          </a>
        </div>
      </div>
    </div>
  )
}
