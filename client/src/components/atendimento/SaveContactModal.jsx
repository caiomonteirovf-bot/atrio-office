import { useState, useEffect, useRef } from 'react'
import { X, Loader2, UserCheck, Handshake, Truck, Sparkles, User, Ban, Users } from 'lucide-react'
import { saveAsContact } from './atendimento-api'

/**
 * Modal pra categorizar uma conversa como NAO-cliente.
 * Captura tipo + label + detalhes (subtipo, descricao, contato pessoa, etc.)
 * pra qualquer atendente entender de cara o que e a relacao.
 */
const TYPES = [
  { id: 'equipe',     label: 'Equipe',     desc: 'Colaborador da Átrio (time interno)',                    Icon: Users,     color: '#06B6D4' },
  { id: 'parceiro',   label: 'Parceiro',   desc: 'Empresa que trabalha junto (ex: WiseHub Certificados)', Icon: Handshake, color: '#8B5CF6' },
  { id: 'fornecedor', label: 'Fornecedor', desc: 'Presta serviço/produto pra Átrio',                      Icon: Truck,     color: '#F59E0B' },
  { id: 'prospect',   label: 'Prospect',   desc: 'Interessado, pode virar cliente',                       Icon: Sparkles,  color: '#10B981' },
  { id: 'pessoal',    label: 'Pessoal',    desc: 'Contato pessoal, não da operação',                      Icon: User,      color: '#64748B' },
  { id: 'cliente_externo', label: 'Cliente de outra contabilidade', desc: 'Recebe ajuda pontual, não está na Carteira', Icon: UserCheck, color: '#3B82F6' },
  { id: 'spam',       label: 'Spam / Ignorar', desc: 'Propaganda, número errado, bot',                    Icon: Ban,       color: '#EF4444' },
]

// Subtipos sugeridos por categoria — orienta sem travar (campo aceita custom).
const SUBTIPOS = {
  parceiro: [
    'Certificado Digital',
    'Sistema/Software',
    'Indicação de Clientes',
    'Banco / Instituição Financeira',
    'Cartório / Junta',
    'Advogado parceiro',
    'Consultor parceiro',
    'Outro',
  ],
  fornecedor: [
    'Tecnologia / SaaS',
    'Material de escritório',
    'Marketing / Agência',
    'Servico de TI',
    'Limpeza / Manutenção',
    'Outro',
  ],
  prospect: [
    'Indicação',
    'Marketing digital',
    'Recomendação cliente',
    'Evento / Feira',
    'Outro',
  ],
  cliente_externo: [
    'Atendimento pontual',
    'Migração em estudo',
    'Outro',
  ],
}

export default function SaveContactModal({ open, onClose, conversation: conv, onSaved }) {
  const [type, setType] = useState('parceiro')
  const [label, setLabel] = useState('')
  const [details, setDetails] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      const existing = conv?.contact_details || {}
      setType(conv?.contact_type || 'parceiro')
      setLabel(conv?.contact_label || (conv?.client_name && conv.client_name !== conv.display_phone ? conv.client_name : ''))
      setDetails({
        subtipo: existing.subtipo || '',
        oque_fazem: existing.oque_fazem || '',
        como_usamos: existing.como_usamos || '',
        contato_pessoa: existing.contato_pessoa || '',
        contato_funcao: existing.contato_funcao || '',
        contato_email: existing.contato_email || '',
        site: existing.site || '',
        cnpj: existing.cnpj || '',
        observacoes: existing.observacoes || '',
      })
      setError(null)
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }, [open, conv?.id])

  if (!open) return null

  const canSave = type && !saving
  const showDetails = ['parceiro', 'fornecedor', 'prospect', 'cliente_externo'].includes(type)
  const subtipoOpts = SUBTIPOS[type] || []

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      // Limpa detalhes vazios
      const cleanDetails = Object.fromEntries(
        Object.entries(details).filter(([_, v]) => v && v.trim())
      )
      await saveAsContact(conv.id, type, label.trim() || null, cleanDetails)
      onSaved?.()
      onClose?.()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const selected = TYPES.find(t => t.id === type) || TYPES[0]
  const setDet = (k, v) => setDetails(prev => ({ ...prev, [k]: v }))

  const inputStyle = {
    width: '100%', padding: '7px 10px', fontSize: 12.5, borderRadius: 7,
    border: '1px solid var(--ao-border)',
    background: 'var(--ao-bg)', color: 'var(--ao-text-primary)',
    fontFamily: 'inherit',
  }
  const labelStyle = { fontSize: 10, fontWeight: 700, opacity: 0.7, textTransform: 'uppercase', display: 'block', marginBottom: 4, letterSpacing: '0.4px' }

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
          width: '100%', maxWidth: 540, maxHeight: '92vh', overflowY: 'auto',
          background: 'var(--ao-card)', borderRadius: 16,
          border: '1px solid var(--ao-border)',
          color: 'var(--ao-text-primary)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--ao-border)',
          display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, background: 'var(--ao-card)', zIndex: 1,
        }}>
          <UserCheck size={16} style={{ color: 'var(--ao-accent, #c4956a)' }} />
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Salvar contato</h3>
            <p style={{ fontSize: 11, color: 'var(--ao-text-dim)', margin: '2px 0 0' }}>
              Quanto mais detalhe, mais rápido qualquer atendente entende a relação.
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--ao-text-dim)', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Tipos — compacto, em grid */}
        <div style={{ padding: '12px 18px 6px' }}>
          <label style={labelStyle}>Tipo</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
            {TYPES.map(t => {
              const active = type === t.id
              const Icon = t.Icon
              return (
                <button
                  key={t.id}
                  onClick={() => setType(t.id)}
                  style={{
                    textAlign: 'left', cursor: 'pointer',
                    padding: '8px 10px', borderRadius: 8,
                    border: `1px solid ${active ? t.color + '66' : 'var(--ao-border)'}`,
                    background: active ? `${t.color}14` : 'var(--ao-bg)',
                    display: 'flex', alignItems: 'center', gap: 8,
                    color: 'var(--ao-text-primary)',
                  }}
                >
                  <div style={{
                    width: 26, height: 26, borderRadius: 7,
                    background: active ? `${t.color}22` : 'var(--ao-surface)',
                    border: active ? `1px solid ${t.color}55` : '1px solid var(--ao-border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: active ? t.color : 'var(--ao-text-dim)',
                    flexShrink: 0,
                  }}>
                    <Icon size={13} strokeWidth={active ? 2.4 : 2} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: active ? 700 : 600, color: active ? t.color : 'inherit' }}>{t.label}</div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Nome do contato */}
        <div style={{ padding: '8px 18px 6px' }}>
          <label style={labelStyle}>Nome do contato / empresa</label>
          <input
            ref={inputRef}
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={
              type === 'parceiro'   ? 'ex: WiseHub Certificados' :
              type === 'fornecedor' ? 'ex: Hostinger, Stripe' :
              type === 'equipe'     ? 'ex: Karla (Recepção)' :
              'ex: Nome ou empresa'
            }
            maxLength={200}
            style={inputStyle}
          />
        </div>

        {/* Detalhes — somente pra tipos que fazem sentido */}
        {showDetails && (
          <div style={{ padding: '6px 18px 12px', background: 'var(--ao-bg)', borderTop: '1px solid var(--ao-border)' }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ao-text-secondary)', margin: '10px 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
              📋 Detalhes da relação
            </div>

            {/* Subtipo */}
            {subtipoOpts.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label style={labelStyle}>Tipo de {selected.label.toLowerCase()}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                  {subtipoOpts.map(opt => (
                    <button
                      key={opt}
                      onClick={() => setDet('subtipo', opt)}
                      style={{
                        fontSize: 10.5, padding: '4px 8px', borderRadius: 12,
                        border: `1px solid ${details.subtipo === opt ? selected.color + '88' : 'var(--ao-border)'}`,
                        background: details.subtipo === opt ? `${selected.color}20` : 'transparent',
                        color: details.subtipo === opt ? selected.color : 'var(--ao-text-dim)',
                        cursor: 'pointer', fontWeight: 600,
                      }}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <input
                  value={details.subtipo || ''}
                  onChange={e => setDet('subtipo', e.target.value)}
                  placeholder="ou digite outro..."
                  style={inputStyle}
                  maxLength={100}
                />
              </div>
            )}

            {/* O que fazem */}
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>O que fazem / vendem</label>
              <input
                value={details.oque_fazem || ''}
                onChange={e => setDet('oque_fazem', e.target.value)}
                placeholder={type === 'parceiro' ? 'ex: Vende certificado digital A1/A3 e tokens' : 'descreva o produto/serviço'}
                style={inputStyle}
                maxLength={300}
              />
            </div>

            {/* Como usamos */}
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>Como a Átrio usa / pra que serve</label>
              <input
                value={details.como_usamos || ''}
                onChange={e => setDet('como_usamos', e.target.value)}
                placeholder={type === 'parceiro' ? 'ex: Encaminhamos clientes para emissao de cert digital' : 'qual o uso pratico'}
                style={inputStyle}
                maxLength={300}
              />
            </div>

            {/* Pessoa de contato + função em linha */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 8, marginBottom: 8 }}>
              <div>
                <label style={labelStyle}>Pessoa de contato</label>
                <input
                  value={details.contato_pessoa || ''}
                  onChange={e => setDet('contato_pessoa', e.target.value)}
                  placeholder="ex: Roberto"
                  style={inputStyle}
                  maxLength={120}
                />
              </div>
              <div>
                <label style={labelStyle}>Função</label>
                <input
                  value={details.contato_funcao || ''}
                  onChange={e => setDet('contato_funcao', e.target.value)}
                  placeholder="ex: Gerente de conta"
                  style={inputStyle}
                  maxLength={80}
                />
              </div>
            </div>

            {/* Email + Site em linha */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <div>
                <label style={labelStyle}>Email (opcional)</label>
                <input
                  value={details.contato_email || ''}
                  onChange={e => setDet('contato_email', e.target.value)}
                  placeholder="contato@empresa.com"
                  style={inputStyle}
                  maxLength={120}
                />
              </div>
              <div>
                <label style={labelStyle}>Site (opcional)</label>
                <input
                  value={details.site || ''}
                  onChange={e => setDet('site', e.target.value)}
                  placeholder="empresa.com.br"
                  style={inputStyle}
                  maxLength={120}
                />
              </div>
            </div>

            {/* Observações */}
            <div>
              <label style={labelStyle}>Observações livres</label>
              <textarea
                value={details.observacoes || ''}
                onChange={e => setDet('observacoes', e.target.value)}
                placeholder="contexto adicional, comissão, condições especiais..."
                style={{ ...inputStyle, minHeight: 50, resize: 'vertical', fontFamily: 'inherit' }}
                maxLength={500}
              />
            </div>
          </div>
        )}

        {error && (
          <div style={{
            margin: '0 18px 12px', padding: 8, borderRadius: 8,
            background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)',
            color: '#ef4444', fontSize: 11,
          }}>
            {error}
          </div>
        )}

        {/* Footer */}
        <div style={{
          padding: '10px 18px', borderTop: '1px solid var(--ao-border)',
          display: 'flex', gap: 8, justifyContent: 'flex-end',
          background: 'var(--ao-bg)', position: 'sticky', bottom: 0,
        }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '8px 14px', fontSize: 12, fontWeight: 600, borderRadius: 8,
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
              padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 8,
              border: 'none',
              background: canSave ? selected.color : 'var(--ao-surface)',
              color: canSave ? '#fff' : 'var(--ao-text-dim)',
              cursor: canSave ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <UserCheck size={12} />}
            Salvar como {selected.label.toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  )
}
