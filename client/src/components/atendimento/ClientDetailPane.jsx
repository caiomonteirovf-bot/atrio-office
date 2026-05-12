import { useEffect, useState } from 'react'
import { Loader2, User, UserCheck, ExternalLink, Link2, Unlink, Building, MapPin, Phone, Mail, FileText, AlertCircle, CheckCircle2, Users, Banknote, Plus, Send } from 'lucide-react'
import { fetchClientContext, unlinkConversationFromClient, fetchPhoneCandidates, linkConversationToClient, fetchExtratosStatus, addClientObservation } from './atendimento-api'
import LinkClientModal from './LinkClientModal'
import SaveContactModal from './SaveContactModal'

/**
 * Painel direito da conversa — mostra dados do cliente vinculado no Gesthub.
 * Se nao tem vinculo, mostra CTA pra vincular ou cadastrar.
 *
 * Props:
 *  - conversation: {id, ...}
 *  - onClose: (mobile) fecha painel
 *  - lastWsMessage: recarrega se evento de link/unlink chegou
 */
export default function ClientDetailPane({ conversation: conv, onClose, lastWsMessage }) {
  const [ctx, setCtx] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkSateliteOpen, setLinkSateliteOpen] = useState(false)
  // Observacao inline
  const [obsOpen, setObsOpen] = useState(false)
  const [obsText, setObsText] = useState('')
  const [obsTipo, setObsTipo] = useState('nota')
  const [obsSaving, setObsSaving] = useState(false)
  const [obsError, setObsError] = useState(null)

  const handleAddObs = async () => {
    const text = obsText.trim()
    if (!text || obsSaving) return
    setObsSaving(true); setObsError(null)
    try {
      await addClientObservation(conv.id, { descricao: text, tipo: obsTipo, autor: 'Atendimento WhatsApp' })
      setObsText(''); setObsOpen(false); setObsTipo('nota')
      await load()
    } catch (e) { setObsError(e.message) }
    finally { setObsSaving(false) }
  }
  const [candidates, setCandidates] = useState([])  // todos clientes com este telefone
  const [switching, setSwitching] = useState(false)
  const [saveContactOpen, setSaveContactOpen] = useState(false)

  const load = async () => {
    if (!conv?.id) return
    setLoading(true); setError(null)
    try {
      const [data, cand] = await Promise.all([
        fetchClientContext(conv.id),
        fetchPhoneCandidates(conv.id).catch(() => ({ data: [] })),
      ])
      setCtx(data)
      setCandidates(cand.data || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [conv?.id])

  const switchToClient = async (clientId) => {
    if (switching || clientId === ctx?.client?.id) return
    setSwitching(true); setError(null)
    try {
      await linkConversationToClient(conv.id, clientId)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSwitching(false) }
  }

  useEffect(() => {
    if (!lastWsMessage) return
    const t = lastWsMessage.type
    if ((t === 'conversation_linked' || t === 'conversation_unlinked') &&
        lastWsMessage.conversation_id === conv?.id) {
      load()
    }
  }, [lastWsMessage])

  const handleUnlink = async () => {
    if (!confirm('Remover o vínculo com o cliente?')) return
    try {
      await unlinkConversationFromClient(conv.id)
      await load()
    } catch (e) { setError(e.message) }
  }

  if (!conv) return null

  // Header estilo
  const header = (
    <div style={{
      padding: '10px 14px', borderBottom: '1px solid var(--ao-border)',
      display: 'flex', alignItems: 'center', gap: 10,
      background: 'var(--ao-card)',
    }}>
      <User size={15} style={{ color: 'var(--ao-text-dim)' }} />
      <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0, flex: 1 }}>Cliente</h3>
      {onClose && (
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--ao-text-dim)', cursor: 'pointer', padding: 4 }} aria-label="Fechar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      )}
    </div>
  )

  if (loading && !ctx) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ao-bg)' }}>
        {header}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
          {ctx?.conversation?.is_group && ctx?.conversation?.chat_id && <GroupParticipants chatId={ctx.conversation.chat_id} />}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5 }}>
          <Loader2 size={16} className="animate-spin" />
        </div>
      </div>
    )
  }

  // Não linkada — CTA com 2 caminhos: vincular cliente OU salvar como outro tipo
  if (ctx && !ctx.linked) {
    // Se ja foi categorizado (parceiro, prospect, etc), mostra status amigavel em vez de "nao identificado"
    const contactType = ctx.conversation?.contact_type
    const contactLabel = ctx.conversation?.contact_label

    if (contactType) {
      const typeMeta = {
        equipe:          { label: 'Equipe',          color: '#06B6D4', desc: 'Colaborador do time Átrio' },
        parceiro:        { label: 'Parceiro',        color: '#8B5CF6', desc: 'Empresa parceira' },
        fornecedor:      { label: 'Fornecedor',      color: '#F59E0B', desc: 'Fornecedor da Átrio' },
        prospect:        { label: 'Prospect',        color: '#10B981', desc: 'Potencial cliente' },
        pessoal:         { label: 'Pessoal',         color: '#64748B', desc: 'Contato pessoal' },
        cliente_externo: { label: 'Cliente externo', color: '#3B82F6', desc: 'Cliente de outra contabilidade' },
        spam:            { label: 'Spam',            color: '#EF4444', desc: 'Propaganda / ignorar' },
      }[contactType] || { label: contactType, color: '#64748B', desc: '' }

      const det = ctx.conversation?.contact_details || {}
      const hasDetails = Object.values(det).some(v => v && typeof v === 'string' && v.trim() && v !== det.updated_at && v !== det.updated_by)

      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ao-bg)' }}>
          {header}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {/* Hero compact */}
            <div style={{ padding: '18px 16px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10, borderBottom: hasDetails ? '1px solid var(--ao-border)' : 'none' }}>
              <div style={{
                width: 56, height: 56, borderRadius: 16,
                background: `${typeMeta.color}20`, color: typeMeta.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${typeMeta.color}40`,
                fontWeight: 800, fontSize: 20,
              }}>
                {(contactLabel || conv.client_name || '?').slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                  {contactLabel || conv.client_name || '--'}
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 100, background: `${typeMeta.color}18`, color: typeMeta.color, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                  {typeMeta.label}{det.subtipo ? ` · ${det.subtipo}` : ''}
                </div>
                <p style={{ fontSize: 11, color: 'var(--ao-text-dim)', margin: '4px 0 0' }}>
                  {ctx.conversation?.real_phone || ctx.conversation?.phone}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setSaveContactOpen(true)}
                  style={{
                    padding: '6px 12px', fontSize: 11, fontWeight: 600, borderRadius: 8,
                    border: '1px solid var(--ao-border)', background: 'transparent',
                    color: 'var(--ao-text-secondary)', cursor: 'pointer',
                  }}
                >
                  {hasDetails ? 'Editar detalhes' : 'Adicionar detalhes'}
                </button>
                <button
                  onClick={() => setLinkOpen(true)}
                  style={{
                    padding: '6px 12px', fontSize: 11, fontWeight: 600, borderRadius: 8,
                    border: 'none', background: 'var(--ao-accent, #6366F1)', color: '#fff',
                    cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                  }}
                >
                  <Link2 size={11} />
                  Virou cliente?
                </button>
              </div>
            </div>

            {/* Detalhes ricos */}
            {hasDetails && (
              <div style={{ padding: '14px 16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {det.oque_fazem && (
                  <DetailField label="O QUE FAZEM" value={det.oque_fazem} />
                )}
                {det.como_usamos && (
                  <DetailField label="COMO A ÁTRIO USA" value={det.como_usamos} />
                )}
                {(det.contato_pessoa || det.contato_funcao) && (
                  <DetailField
                    label="PESSOA DE CONTATO"
                    value={[det.contato_pessoa, det.contato_funcao].filter(Boolean).join(' · ')}
                  />
                )}
                {det.contato_email && (
                  <DetailField label="EMAIL" value={det.contato_email} link={`mailto:${det.contato_email}`} />
                )}
                {det.site && (
                  <DetailField
                    label="SITE"
                    value={det.site}
                    link={det.site.startsWith('http') ? det.site : `https://${det.site}`}
                  />
                )}
                {det.cnpj && (
                  <DetailField label="CNPJ" value={det.cnpj} mono />
                )}
                {det.observacoes && (
                  <DetailField label="OBSERVAÇÕES" value={det.observacoes} />
                )}
              </div>
            )}

            {!hasDetails && (
              <div style={{ padding: '8px 20px 22px', textAlign: 'center' }}>
                <p style={{ fontSize: 11, color: 'var(--ao-text-dim)', margin: 0, lineHeight: 1.5 }}>
                  {typeMeta.desc}. Clique em <strong>Adicionar detalhes</strong> pra registrar tipo de parceria, contato chave e o que fazem — assim qualquer atendente entende a relação rapidamente.
                </p>
              </div>
            )}
          </div>
          <LinkClientModal
            open={linkOpen}
            onClose={() => setLinkOpen(false)}
            conversation={ctx?.conversation || conv}
            onLinked={load}
          />
          <SaveContactModal
            open={saveContactOpen}
            onClose={() => setSaveContactOpen(false)}
            conversation={ctx?.conversation || conv}
            onSaved={load}
          />
        </div>
      )
    }

    // Ainda nao categorizado
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ao-bg)' }}>
        {header}
        <div style={{ padding: '22px 20px', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 14 }}>
          <div style={{
            width: 60, height: 60, borderRadius: 18,
            background: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid rgba(245, 158, 11, 0.35)',
          }}>
            <AlertCircle size={28} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{ctx.conversation?.is_group ? "Grupo não identificado" : "Contato não identificado"}</div>
            <p style={{ fontSize: 11.5, color: 'var(--ao-text-dim)', margin: 0, maxWidth: 270, lineHeight: 1.5 }}>
              {ctx.conversation?.is_group ? <>Este grupo do WhatsApp não está vinculado a nenhum cliente da Carteira.</> : <>O número <strong>{ctx.conversation?.real_phone || ctx.conversation?.phone}</strong> não está na Carteira.</>}
              É cliente, parceiro ou outro tipo de contato?
            </p>
          </div>

          {/* 2 opcoes: cliente ou outro */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 280, marginTop: 4 }}>
            <button
              onClick={() => setLinkOpen(true)}
              style={{
                padding: '10px 14px', fontSize: 12.5, fontWeight: 700, borderRadius: 10,
                border: 'none', background: 'var(--ao-accent, #6366F1)', color: '#fff',
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <Link2 size={13} />
              É cliente da Átrio
            </button>
            <button
              onClick={() => setLinkSateliteOpen(true)}
              title="Esse contato (tomador, sócio, contador, financeiro) representa um cliente que JÁ está na Carteira"
              style={{
                padding: '10px 14px', fontSize: 12.5, fontWeight: 700, borderRadius: 10,
                border: '1px solid var(--ao-border)',
                background: 'rgba(99, 102, 241, 0.08)',
                color: 'var(--ao-text-primary)',
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <Users size={13} />
              Tomador / contato de cliente
            </button>
            <button
              onClick={() => setSaveContactOpen(true)}
              style={{
                padding: '10px 14px', fontSize: 12.5, fontWeight: 600, borderRadius: 10,
                border: '1px solid var(--ao-border)', background: 'var(--ao-card)',
                color: 'var(--ao-text-primary)', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <UserCheck size={13} />
              Salvar como parceiro / outro
            </button>
          </div>

          <a
            href="http://31.97.175.200"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 10.5, color: 'var(--ao-text-dim)', textDecoration: 'underline',
              display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4,
            }}
          >
            <ExternalLink size={10} />
            cadastrar novo cliente no Gesthub
          </a>
        </div>
        <LinkClientModal
          open={linkOpen}
          onClose={() => setLinkOpen(false)}
          conversation={ctx?.conversation || conv}
          onLinked={load}
        />
        <LinkClientModal
          open={linkSateliteOpen}
          onClose={() => setLinkSateliteOpen(false)}
          conversation={ctx?.conversation || conv}
          onLinked={load}
          mode="satelite"
        />
        <SaveContactModal
          open={saveContactOpen}
          onClose={() => setSaveContactOpen(false)}
          conversation={ctx?.conversation || conv}
          onSaved={load}
        />
      </div>
    )
  }

  // Banner/switcher quando ha mais de 1 cliente com o mesmo telefone
  const explicitLinks = (ctx?.clients || []).length > 1
  const multiCompany = !explicitLinks && candidates.length > 1
  const multiBanner = multiCompany && (
    <div style={{
      padding: '8px 14px', borderBottom: '1px solid var(--ao-border)',
      background: 'rgba(245, 158, 11, 0.08)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
        fontSize: 10.5, fontWeight: 700, color: '#F59E0B',
        textTransform: 'uppercase', letterSpacing: '0.4px',
      }}>
        <Users size={12} />
        <span>Este contato tem {candidates.length} empresas</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {candidates.map(c => {
          const active = c.id === ctx?.client?.id
          return (
            <button
              key={c.id}
              onClick={() => switchToClient(c.id)}
              disabled={switching || active}
              style={{
                textAlign: 'left', cursor: active ? 'default' : (switching ? 'wait' : 'pointer'),
                padding: '6px 8px', borderRadius: 5,
                border: `1px solid ${active ? 'rgba(16,185,129,0.35)' : 'var(--ao-border)'}`,
                background: active ? 'rgba(16,185,129,0.1)' : 'var(--ao-card)',
                color: 'var(--ao-text-primary)', fontSize: 11,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {active ? <CheckCircle2 size={11} style={{ color: '#10B981', flexShrink: 0 }} /> : <div style={{ width: 11, height: 11, borderRadius: '50%', border: '1px solid var(--ao-text-dim)', flexShrink: 0 }} />}
              <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: active ? 600 : 500 }}>
                {c.legalName || c.tradeName}
              </span>
              <span style={{ fontSize: 9.5, color: 'var(--ao-text-dim)', flexShrink: 0 }}>
                {c.status === 'ATIVO' ? '●' : '○'} {c.type || '--'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  // Linkada — render completo
  const cli = ctx?.client || {}
  const badges = ctx?.badges
  const observacoes = ctx?.observacoes || []
  const legalizacoes = ctx?.legalizacoes || []
  const onboardings = ctx?.onboardings || []
  const activeOnb = onboardings.find(o => o.status === 'em_andamento') || onboardings[0]
  const activeLegal = legalizacoes.filter(l => l.status !== 'CONCLUIDO' && l.status !== 'CANCELADO')
  const primaryContact = Array.isArray(cli.contatos) ? cli.contatos[0] : null

  // Helper p/ pill pequeno colorido
  const pill = (label, bg, fg) => (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: bg, color: fg }}>
      {label}
    </span>
  )

  // Banner satelite — quando o vinculo eh por relacao (tomador, socio, etc), explica
  // que a conversa nao eh com o cliente em si, eh com um terceiro RELACIONADO ao cliente.
  const sateliteLink = ctx?.primaryLink?.relacao
    ? {
        relacao: ctx.primaryLink.relacao,
        contato_funcao: ctx.primaryLink.contato_funcao,
        clientName: cli.legalName || cli.tradeName,
      }
    : null
  const RELACAO_DESC = {
    tomador:    { label: 'Tomador',    desc: 'Solicita NFS-e desta cliente' },
    socio:      { label: 'Sócio',      desc: 'Sócio/representante desta cliente' },
    contador:   { label: 'Contador',   desc: 'Contador parceiro desta cliente' },
    financeiro: { label: 'Financeiro', desc: 'Setor financeiro desta cliente' },
    outro:      { label: 'Outro',      desc: 'Relacionado a esta cliente' },
  }
  const sateliteBanner = sateliteLink && (
    <div style={{
      padding: '10px 14px', borderBottom: '1px solid var(--ao-border)',
      background: 'rgba(99, 102, 241, 0.08)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
        fontSize: 10.5, fontWeight: 800, color: 'rgba(99, 102, 241, 0.95)',
        textTransform: 'uppercase', letterSpacing: '0.4px',
      }}>
        <Users size={11} />
        <span>{(RELACAO_DESC[sateliteLink.relacao] || RELACAO_DESC.outro).label} de cliente</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--ao-text-secondary)', lineHeight: 1.45 }}>
        Este contato NÃO é o cliente — é um {sateliteLink.relacao}{' '}
        relacionado a <strong style={{ color: 'var(--ao-text-primary)' }}>{sateliteLink.clientName}</strong>.
        {sateliteLink.contato_funcao && (
          <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--ao-text-dim)', fontStyle: 'italic' }}>
            {sateliteLink.contato_funcao}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--ao-bg)', overflowY: 'auto' }}>
      {header}
      {sateliteBanner}
      {multiBanner}
      {ctx?.clients && ctx.clients.length > 1 && (
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--ao-border)', background: 'rgba(99,102,241,0.06)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#6366F1', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Users size={11} /> {ctx.clients.length} empresas vinculadas
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ctx.clients.map(c => {
              const active = c.id === cli.id
              return (
                <div key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 8px', borderRadius: 5,
                  border: `1px solid ${active ? 'rgba(99,102,241,0.4)' : 'var(--ao-border)'}`,
                  background: active ? 'rgba(99,102,241,0.12)' : 'var(--ao-card)',
                }}>
                  <button onClick={() => switchToClient(c.id)} disabled={active}
                    style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: active ? 'default' : 'pointer', fontSize: 11, color: 'var(--ao-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: 0 }}>
                    {active ? '● ' : '○ '}{c.legalName || c.tradeName}
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm(`Desvincular "${c.legalName || c.tradeName}" desta conversa?`)) return
                      await fetch(`/api/atendimento/conversation/${ctx.conversation.id}/unlink-client`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ client_id: c.id }),
                      })
                      load()
                    }}
                    title="Desvincular esta empresa"
                    style={{ background: 'transparent', border: 'none', color: 'var(--ao-text-dim)', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}>×</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Card identidade — hero com gradient por tipo de cliente */}
      {(() => {
        const TYPE_GRADIENTS = {
          'MEDICINA':   ['#10B981', '#059669'],
          'MEDICOS':    ['#10B981', '#059669'],
          'ADV':        ['#7F77DD', '#5B52B6'],
          'ADVOCACIA':  ['#7F77DD', '#5B52B6'],
          'ENGENHARIA': ['#FB923C', '#EA580C'],
          'CONTABIL':   ['#60A5FA', '#2563EB'],
          'COMERCIO':   ['#FBBF24', '#D97706'],
          'TECNOLOGIA': ['#22D3EE', '#0891B2'],
        }
        const inactive = cli.status !== 'ATIVO'
        const t = (cli.type || '').toUpperCase()
        const [c1, c2] = inactive ? ['#94A3B8', '#64748B'] : (TYPE_GRADIENTS[t] || ['#10B981', '#059669'])
        return (
          <div style={{
            padding: '18px 16px 14px',
            borderBottom: '1px solid var(--ao-border)',
            background: `linear-gradient(135deg, ${c1}11 0%, ${c2}08 100%)`,
            position: 'relative',
            overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 3,
              background: `linear-gradient(90deg, ${c1}, ${c2})`,
            }} />
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: `linear-gradient(135deg, ${c1}, ${c2})`,
            color: '#fff', fontSize: 15, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            boxShadow: `0 4px 12px ${c1}30`,
          }}>
            {(cli.legalName || cli.tradeName || '?').slice(0, 2).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ao-text-primary)', lineHeight: 1.2 }}>
              {cli.legalName || '--'}
            </div>
            {cli.tradeName && cli.tradeName !== cli.legalName && (
              <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', marginTop: 1 }}>{cli.tradeName}</div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              {cli.status && pill(cli.status, cli.status === 'ATIVO' ? 'rgba(16,185,129,0.15)' : 'rgba(100,116,139,0.2)', cli.status === 'ATIVO' ? '#10B981' : '#94A3B8')}
              {cli.type && cli.type !== 'GERAL' && pill(cli.type, 'rgba(99,102,241,0.15)', '#6366F1')}
              {cli.taxRegime && pill(cli.taxRegime, 'rgba(245,158,11,0.15)', '#F59E0B')}
            </div>
          </div>
        </div>

        {/* Grid de detalhes */}
        <div style={{ marginTop: 12, fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <DetailRow icon={<Building size={11} />} label="Documento">{cli.document || '--'}</DetailRow>
          {cli.city && <DetailRow icon={<MapPin size={11} />} label="Local">{cli.city}/{cli.state}</DetailRow>}
          {cli.officeOwner && <DetailRow icon={<User size={11} />} label="Sócio resp.">{cli.officeOwner}</DetailRow>}
          {cli.analyst && <DetailRow icon={<User size={11} />} label="Analista">{cli.analyst}</DetailRow>}
          {cli.headcount > 0 && <DetailRow icon={<User size={11} />} label="HC">{cli.headcount}</DetailRow>}
          {primaryContact?.nome && (
            <>
              <DetailRow icon={<Phone size={11} />} label="Contato">{primaryContact.nome}{primaryContact.funcao ? ` (${primaryContact.funcao})` : ''}</DetailRow>
              {primaryContact.email && <DetailRow icon={<Mail size={11} />} label="Email">{primaryContact.email}</DetailRow>}
            </>
          )}
        </div>

        {/* Botoes acao — abrir no Gesthub */}
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          <LinkBtn href={`http://31.97.175.200/?client=${cli.id}&tab=cliente-360`}>Abrir Cliente 360</LinkBtn>
          <LinkBtn href={`http://31.97.175.200/?client=${cli.id}&tab=carteira`}>Carteira</LinkBtn>
          {activeLegal.length > 0 && <LinkBtn href={`http://31.97.175.200/?client=${cli.id}&tab=legalizacao`}>Legalização ({activeLegal.length})</LinkBtn>}
          {activeOnb && <LinkBtn href={`http://31.97.175.200/?client=${cli.id}&tab=onboarding`}>Onboarding (Fase {activeOnb.faseAtual || 1}/6)</LinkBtn>}
          <button
            onClick={() => setLinkOpen(true)}
            title="Vincular outra empresa a esta conversa"
            style={{
              padding: '4px 10px', fontSize: 10.5, fontWeight: 600, borderRadius: 6,
              border: '1px dashed var(--ao-border)', background: 'transparent',
              color: 'var(--ao-text-secondary)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            + Vincular outra empresa
          </button>
        </div>
      </div>
        )
      })()}

      {/* Ecossistema (badges datalake) */}
      {badges && (badges.finance || badges.nfse || badges.fornecedores) && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ao-border)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ao-text-dim)', marginBottom: 6 }}>
            Ecossistema Átrio
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
            {badges.finance && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#10B981', fontWeight: 600 }}>Finance</span>
                <span style={{ color: 'var(--ao-text-dim)' }}>
                  {badges.finance.transacoes} trx · {badges.finance.extratos} extrato(s)
                  {badges.finance.ultimaData ? ` · ult ${String(badges.finance.ultimaData).slice(0, 10)}` : ''}
                </span>
              </div>
            )}
            {badges.nfse && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#3B82F6', fontWeight: 600 }}>NFS-e</span>
                <span style={{ color: 'var(--ao-text-dim)' }}>
                  {badges.nfse.emitidas} emitida(s){badges.nfse.pendentes ? ` · ${badges.nfse.pendentes} pend` : ''}
                </span>
              </div>
            )}
            {badges.fornecedores && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#F59E0B', fontWeight: 600 }}>Fornecedores</span>
                <span style={{ color: 'var(--ao-text-dim)' }}>
                  {badges.fornecedores.total} em {badges.fornecedores.totalTransacoes} trx
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Observações importantes (do Gesthub Cliente 360) — sempre renderiza
           quando ha cliente vinculado, pra permitir adicionar nova obs inline */}
      {cli?.id && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ao-border)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ao-text-dim)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>📌 Observações{observacoes.length > 0 ? ` — ${observacoes.length}` : ''}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => setObsOpen(v => !v)}
                title="Adicionar observação que vai pro histórico do cliente no Gesthub"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                  border: `1px solid ${obsOpen ? 'rgba(99, 102, 241, 0.4)' : 'var(--ao-border)'}`,
                  background: obsOpen ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                  color: obsOpen ? 'rgba(99, 102, 241, 0.95)' : 'var(--ao-text-secondary)',
                  cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '.04em',
                }}
              >
                <Plus size={10} /> Nota
              </button>
              <a href={`http://31.97.175.200/?client=${cli.id}&tab=cliente360`} target="_blank" rel="noreferrer" style={{ color: 'var(--ao-accent, #6366F1)', fontSize: 10, fontWeight: 600 }}>Ver no 360 →</a>
            </div>
          </div>

          {/* Form inline de adicionar observacao */}
          {obsOpen && (
            <div style={{
              marginBottom: 10, padding: '8px 10px', borderRadius: 6,
              border: '1px solid rgba(99, 102, 241, 0.3)',
              background: 'rgba(99, 102, 241, 0.05)',
            }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                {[
                  ['nota', '📝 Nota', '#F59E0B'],
                  ['alerta', '⚠️ Alerta', '#EF4444'],
                ].map(([id, label, color]) => (
                  <button
                    key={id}
                    onClick={() => setObsTipo(id)}
                    type="button"
                    style={{
                      padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                      border: `1px solid ${obsTipo === id ? color : 'var(--ao-border)'}`,
                      background: obsTipo === id ? `${color}22` : 'transparent',
                      color: obsTipo === id ? color : 'var(--ao-text-dim)',
                      cursor: 'pointer',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <textarea
                value={obsText}
                onChange={e => setObsText(e.target.value)}
                placeholder="Descreva o que aconteceu — ex: Cliente perdeu Simples Nacional por débitos..."
                rows={3}
                autoFocus
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleAddObs()
                  if (e.key === 'Escape') { setObsOpen(false); setObsText('') }
                }}
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 6,
                  border: '1px solid var(--ao-border)', background: 'var(--ao-bg)',
                  color: 'var(--ao-text-primary)', fontSize: 12, resize: 'vertical',
                  fontFamily: 'inherit', lineHeight: 1.4,
                }}
              />
              {obsError && (
                <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{obsError}</div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                <span style={{ fontSize: 9.5, color: 'var(--ao-text-dim)' }}>
                  Vai pro histórico do cliente no Gesthub. Ctrl+Enter pra salvar.
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => { setObsOpen(false); setObsText(''); setObsError(null) }}
                    type="button"
                    style={{
                      padding: '5px 10px', fontSize: 11, fontWeight: 600,
                      borderRadius: 5, border: '1px solid var(--ao-border)',
                      background: 'transparent', color: 'var(--ao-text-secondary)', cursor: 'pointer',
                    }}
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleAddObs}
                    disabled={!obsText.trim() || obsSaving}
                    type="button"
                    style={{
                      padding: '5px 12px', fontSize: 11, fontWeight: 700,
                      borderRadius: 5, border: 'none',
                      background: obsText.trim() && !obsSaving ? 'var(--ao-accent, #6366F1)' : 'var(--ao-card)',
                      color: obsText.trim() && !obsSaving ? '#fff' : 'var(--ao-text-dim)',
                      cursor: obsText.trim() && !obsSaving ? 'pointer' : 'not-allowed',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    {obsSaving ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                    {obsSaving ? 'Salvando...' : 'Salvar'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {observacoes.length === 0 && !obsOpen && (
            <p style={{ fontSize: 11, color: 'var(--ao-text-dim)', margin: '4px 0 0', fontStyle: 'italic' }}>
              Nenhuma observação registrada. Clique em <strong>+ Nota</strong> pra adicionar.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
            {observacoes.map((o, i) => {
              const tipo = (o.tipo || '').toLowerCase()
              // cor por tipo
              const palette = {
                nota:        { bg: 'rgba(245, 158, 11, 0.10)', border: '#f59e0b', icon: '📝' },
                alerta:      { bg: 'rgba(239, 68, 68, 0.10)',  border: '#ef4444', icon: '⚠️' },
                onboarding:  { bg: 'rgba(99, 102, 241, 0.10)', border: '#6366f1', icon: '🚀' },
                irpf:        { bg: 'rgba(16, 185, 129, 0.10)', border: '#10b981', icon: '📊' },
                legalizacao: { bg: 'rgba(59, 130, 246, 0.10)', border: '#3b82f6', icon: '📋' },
                entrega:     { bg: 'rgba(139, 92, 246, 0.10)', border: '#8b5cf6', icon: '📦' },
                _default:    { bg: 'var(--ao-surface)',         border: 'var(--ao-border)', icon: '•' },
              }
              const p = palette[tipo] || palette._default
              const texto = o.descricao || o.texto || ''
              const data = o.data || o.createdAt
              const autor = o.autor || o.source || ''
              return (
                <div
                  key={o.id || i}
                  style={{
                    fontSize: 11, padding: '7px 10px', borderRadius: 6,
                    background: p.bg, borderLeft: `3px solid ${p.border}`,
                    color: 'var(--ao-text-primary)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3, gap: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: p.border }}>
                      {p.icon} {tipo || 'nota'}
                    </span>
                    {data && (
                      <span style={{ fontSize: 9.5, color: 'var(--ao-text-dim)' }}>
                        {String(data).slice(0, 10).split('-').reverse().join('/')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, lineHeight: 1.35, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {texto}
                  </div>
                  {autor && autor !== 'Cadastro' && (
                    <div style={{ fontSize: 9.5, color: 'var(--ao-text-dim)', marginTop: 3 }}>— {autor}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Legalizacoes ativas */}
      {activeLegal.length > 0 && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ao-border)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ao-text-dim)', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
            <span>Legalização — {activeLegal.length} ativo(s)</span>
            <a href={`http://31.97.175.200/?client=${cli.id}&tab=legalizacao`} target="_blank" rel="noreferrer" style={{ color: 'var(--ao-accent, #6366F1)', fontSize: 10, fontWeight: 600 }}>Ver tudo →</a>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
            {activeLegal.map((l, i) => {
              const stCol = l.status === 'EM EXIGENCIA' ? '#EF4444'
                : l.status === 'AGUARDANDO ORGAO' ? '#F59E0B'
                : l.status === 'PARADO' ? '#94A3B8'
                : l.status === 'AGUARDANDO DOCUMENTOS' ? '#3B82F6'
                : '#10B981'
              return (
                <a
                  key={i}
                  href={`http://31.97.175.200/?client=${cli.id}&tab=legalizacao&legalizationId=${l.id}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 11, padding: '8px 10px', borderRadius: 6,
                    background: 'var(--ao-surface)', border: '1px solid var(--ao-border)',
                    borderLeft: `3px solid ${stCol}`,
                    textDecoration: 'none', color: 'var(--ao-text-primary)',
                    display: 'block', cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 11.5 }}>{l.processType || 'Processo'}</span>
                    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: stCol + '22', color: stCol, fontWeight: 700, textTransform: 'uppercase' }}>
                      {l.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {l.organ && <span>📋 {l.organ}</span>}
                    {l.protocol && <span>#{l.protocol}</span>}
                    {l.expectedDate && <span>📅 {new Date(l.expectedDate + 'T00:00:00').toLocaleDateString('pt-BR')}</span>}
                  </div>
                  {l.pendencies && l.pendencies !== '--' && (
                    <div style={{ fontSize: 10, marginTop: 4, padding: '3px 6px', borderRadius: 3, background: 'rgba(239,68,68,0.08)', color: '#EF4444' }}>
                      ⚠ {String(l.pendencies).slice(0, 100)}
                    </div>
                  )}
                </a>
              )
            })}
          </div>
        </div>
      )}

      {/* Extratos do cliente — status mensal (jan-dez do ano corrente) */}
      <ExtratosSection clienteId={cli.id} />

      {/* Controle de vinculo */}
      <div style={{ padding: '10px 16px', marginTop: 'auto', borderTop: '1px solid var(--ao-border)', background: 'var(--ao-card)' }}>
        <button
          onClick={handleUnlink}
          style={{
            fontSize: 10.5, color: 'var(--ao-text-dim)', background: 'transparent',
            border: 'none', cursor: 'pointer', padding: 0,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <Unlink size={10} />
          Desvincular este contato (vínculo errado?)
        </button>
      </div>

      <LinkClientModal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        conversation={conv}
        onLinked={load}
      />
    </div>
  )
}

function DetailRow({ icon, label, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--ao-text-dim)', marginTop: 2 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.4px', color: 'var(--ao-text-dim)', fontWeight: 600 }}>{label}</div>
        <div style={{ color: 'var(--ao-text-primary)', wordBreak: 'break-word' }}>{children}</div>
      </div>
    </div>
  )
}

function LinkBtn({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontSize: 10.5, padding: '5px 9px', borderRadius: 5,
        border: '1px solid var(--ao-border)', background: 'var(--ao-surface)',
        color: 'var(--ao-text-primary)', textDecoration: 'none',
        display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
      }}
    >
      {children}
      <ExternalLink size={10} style={{ opacity: 0.5 }} />
    </a>
  )
}

function DetailField({ label, value, link, mono }) {
  if (!value) return null
  const valueEl = (
    <div style={{
      fontSize: 12.5,
      color: 'var(--ao-text-primary)',
      fontFamily: mono ? 'Space Grotesk, monospace' : 'inherit',
      lineHeight: 1.45,
      wordBreak: 'break-word',
    }}>
      {value}
    </div>
  )
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 8,
      background: 'var(--ao-card)',
      border: '1px solid var(--ao-border)',
    }}>
      <div style={{
        fontSize: 9.5, fontWeight: 700, opacity: 0.6,
        textTransform: 'uppercase', letterSpacing: '0.5px',
        marginBottom: 4,
      }}>
        {label}
      </div>
      {link ? (
        <a
          href={link}
          target={link.startsWith('http') ? '_blank' : undefined}
          rel="noreferrer"
          style={{ textDecoration: 'none', color: 'var(--ao-accent, #6366F1)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          {valueEl}
          <ExternalLink size={10} style={{ opacity: 0.5 }} />
        </a>
      ) : valueEl}
    </div>
  )
}

// ─── Seção "Extratos" no painel direito ──────────────────────────────────
// Carrega status mensal via /api/atendimento/extratos-status/:cliente_id (proxy Finance).
// Mostra grid 12 meses com cor por status.
const MES_ABREV = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function ExtratosSection({ clienteId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [showFuture, setShowFuture] = useState(false);

  useEffect(() => {
    if (!clienteId) return;
    let alive = true;
    setLoading(true); setErr(null);
    fetchExtratosStatus(clienteId, ano)
      .then(d => { if (alive) setData(d.data); })
      .catch(e => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [clienteId, ano]);

  if (!clienteId) return null;

  const STATUS_STYLE = {
    RECEBIDO:     { label: '✓',  color: '#10B981', bg: 'rgba(16, 185, 129, 0.18)', tip: 'Recebido' },
    PARCIAL:      { label: '½',  color: '#3B82F6', bg: 'rgba(59, 130, 246, 0.18)', tip: 'Parcial — falta conta' },
    INCOMPLETO:   { label: '◔',  color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.18)', tip: 'Incompleto — período curto' },
    EM_FILA:      { label: '⏳', color: '#7F77DD', bg: 'rgba(127, 119, 221, 0.18)', tip: 'Em fila no Finance, aguardando aprovação' },
    EM_ANDAMENTO: { label: '◑',  color: '#94A3B8', bg: 'rgba(148, 163, 184, 0.18)', tip: 'Mês em curso' },
    PENDENTE:     { label: '?',  color: '#EF4444', bg: 'rgba(239, 68, 68, 0.18)',  tip: 'Pendente — atrasado' },
    COBRADO:      { label: '!',  color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.18)', tip: 'Cobrado — aguardando' },
    DISPENSADO:   { label: '—',  color: '#94A3B8', bg: 'rgba(148, 163, 184, 0.12)', tip: 'Dispensado' },
  };
  const futureStyle = { label: '·', color: 'var(--ao-text-dim)', bg: 'transparent', tip: 'Mês futuro' };

  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--ao-border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--ao-text-dim)', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Banknote size={11} /> Extratos — {ano}
          {data?.totalContas > 0 && <span style={{ color: 'var(--ao-text-dim)', fontWeight: 500, textTransform: 'none' }}>({data.totalContas} conta{data.totalContas > 1 ? 's' : ''})</span>}
        </span>
        <a
          href={`http://31.97.175.200:3000/?cliente_id=${clienteId}#painel`}
          target="_blank"
          rel="noreferrer"
          style={{ color: 'var(--ao-accent, #6366F1)', fontSize: 10, fontWeight: 600 }}
        >
          Ver no Finance →
        </a>
      </div>

      {loading && <div style={{ fontSize: 11, color: 'var(--ao-text-dim)' }}>Carregando…</div>}
      {err && <div style={{ fontSize: 11, color: '#EF4444' }}>{err}</div>}

      {data?.meses && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(36px, 1fr))', gap: 4 }}>
            {(() => {
              // Mostra apenas meses passados + atual por padrão. Se showFuture, expande pra 12.
              const anoNum = parseInt(ano);
              const isCurrentYear = anoNum === new Date().getFullYear();
              const lastMonth = (showFuture || !isCurrentYear) ? 12 : new Date().getMonth() + 1;
              return Array.from({ length: lastMonth }, (_, i) => i);
            })().map(i => {
              const m = String(i + 1);
              const item = data.meses[m] || {};
              const st = STATUS_STYLE[item.status] || (item.status ? { label: item.status[0], color: '#94A3B8', bg: 'rgba(148, 163, 184, 0.18)', tip: item.status } : futureStyle);
              return (
                <div
                  key={m}
                  title={`${MES_ABREV[i]} ${ano}: ${st.tip}${item.uploads ? ` · ${item.uploads} upload(s) · ${item.transacoes || 0} trx` : ''}${item.pendingCount ? ` · ${item.pendingCount} em fila` : ''}`}
                  style={{
                    padding: '6px 4px', borderRadius: 5, textAlign: 'center',
                    background: st.bg, color: st.color,
                    border: `1px solid ${st.color}33`,
                    fontSize: 11,
                  }}
                >
                  <div style={{ fontSize: 9, fontWeight: 600, opacity: 0.75 }}>{MES_ABREV[i]}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.1 }}>{st.label}</div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 6, fontSize: 9.5, color: 'var(--ao-text-dim)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: '#10B981' }}>✓ recebido</span>
            <span style={{ color: '#7F77DD' }}>⏳ em fila</span>
            <span style={{ color: '#3B82F6' }}>½ parcial</span>
            <span style={{ color: '#F59E0B' }}>◔ incompleto</span>
            <span style={{ color: '#EF4444' }}>? pendente</span>
            {parseInt(ano) === new Date().getFullYear() && (
              <button
                onClick={() => setShowFuture(v => !v)}
                type="button"
                style={{
                  marginLeft: 'auto', fontSize: 9.5, fontWeight: 600,
                  background: 'transparent', border: 'none',
                  color: 'var(--ao-text-dim)', cursor: 'pointer', padding: '2px 4px',
                  textDecoration: 'underline', textUnderlineOffset: 2,
                }}
              >
                {showFuture ? 'ocultar futuros' : 'ver futuros →'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// GroupParticipants — lista membros de um grupo WhatsApp.
// ============================================================
function GroupParticipants({ chatId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    if (data || loading) return;
    setLoading(true); setErr(null);
    try {
      const encoded = encodeURIComponent(chatId);
      const r = await fetch(`/api/whatsapp/group/${encoded}/participants`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      setErr(e.message);
    } finally { setLoading(false); }
  };

  const handleToggle = () => {
    if (!open) load();
    setOpen(o => !o);
  };

  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--ao-border)' }}>
      <button
        type="button"
        onClick={handleToggle}
        style={{
          width: '100%', padding: '8px 10px', fontSize: 11.5, fontWeight: 700,
          background: 'var(--ao-card)', border: '1px solid var(--ao-border)',
          borderRadius: 8, cursor: 'pointer',
          color: 'var(--ao-text-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          textTransform: 'uppercase', letterSpacing: '0.4px',
        }}
      >
        <span>👥 Participantes do grupo {data?.total ? `(${data.total})` : ''}</span>
        <span style={{ fontSize: 13, opacity: 0.6 }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {loading && <div style={{ fontSize: 11, color: 'var(--ao-text-dim)' }}>Carregando...</div>}
          {err && <div style={{ fontSize: 11, color: 'var(--ao-danger, #dc2626)' }}>Erro: {err}</div>}
          {data && (
            <>
              {data.group_name && (
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--ao-text-primary)' }}>
                  {data.group_name}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
                {data.participants.map(p => (
                  <div key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 8px', borderRadius: 6,
                    background: 'var(--ao-card)',
                    border: '1px solid var(--ao-border)',
                  }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                      background: 'linear-gradient(135deg, #6366F1, #818CF8)',
                      color: '#fff', fontWeight: 700, fontSize: 9,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {(p.name || '?').slice(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ao-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </div>
                      {p.phone && p.name !== p.phone && (
                        <div style={{ fontSize: 10, color: 'var(--ao-text-muted)' }}>
                          +{p.phone}
                        </div>
                      )}
                    </div>
                    {(p.isAdmin || p.isSuperAdmin) && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                        background: 'rgba(99, 102, 241, 0.15)', color: 'var(--ao-accent)',
                        textTransform: 'uppercase', letterSpacing: '0.3px',
                      }}>
                        {p.isSuperAdmin ? 'Dono' : 'Admin'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

