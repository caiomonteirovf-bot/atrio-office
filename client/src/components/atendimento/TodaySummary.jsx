import { useEffect, useState } from 'react'
import { X, Loader2, AlertCircle, FileText, MessageSquare, CheckCircle2, Clock, Sparkles } from 'lucide-react'

/**
 * Drawer "Hoje" — auditoria operacional do dia.
 *  - Conversas abertas / resolvidas / aguardando / auto-resolvidas
 *  - Tasks criadas / concluídas / bloqueadas
 *  - Extratos recebidos: importados pelo Finance vs em fila de aprovação
 *
 * Props:
 *  - open: bool
 *  - onClose: fn
 */
export default function TodaySummary({ open, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [date] = useState(() => new Date().toISOString().slice(0, 10))
  const [narrative, setNarrative] = useState(null)
  const [narrativeLoading, setNarrativeLoading] = useState(false)
  const [narrativeError, setNarrativeError] = useState(null)

  const narrate = async () => {
    setNarrativeLoading(true)
    setNarrativeError(null)
    try {
      const r = await fetch('/api/atendimento/daily-summary/narrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setNarrative(j.text)
      // se trouxe summary atualizado, refresca
      if (j.summary) setData(j.summary)
    } catch (e) {
      setNarrativeError(e.message)
    } finally {
      setNarrativeLoading(false)
    }
  }

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/atendimento/daily-summary?date=${date}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setData(j)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    if (open) {
      load()
      // reset narrativa ao reabrir — usuario sempre ve dados fresh
      setNarrative(null)
      setNarrativeError(null)
    }
  }, [open])

  if (!open) return null

  const a = data?.atendimento || {}
  const t = data?.tasks || {}
  const ex = data?.extratos || {}
  const lista = ex.lista || []

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(540px, 100%)', height: '100%',
          background: 'var(--ao-bg)',
          borderLeft: '1px solid var(--ao-border)',
          overflowY: 'auto',
          animation: 'slideInRight 0.22s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid var(--ao-border)',
          position: 'sticky', top: 0,
          background: 'var(--ao-bg)', zIndex: 1,
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ao-text-primary)' }}>
              Hoje · {new Date(date + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', weekday: 'short' })}
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--ao-text-dim)' }}>
              Auditoria operacional · atualiza ao abrir
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              padding: 6, borderRadius: 6, color: 'var(--ao-text-secondary)',
            }}
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16 }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: 30, color: 'var(--ao-text-dim)' }}>
              <Loader2 size={20} className="animate-spin" />
            </div>
          )}
          {error && (
            <div style={{
              padding: 12, borderRadius: 8, marginBottom: 12,
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
              color: '#ef4444', fontSize: 12,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          {data && (
            <>
              {/* Atendimento */}
              <Section title="Atendimento WhatsApp" icon={<MessageSquare size={14} />}>
                <CardRow>
                  <Stat label="Abertas hoje" value={a.abertas_hoje} color="#3B82F6" />
                  <Stat label="Resolvidas hoje" value={a.resolvidas_hoje} color="#10B981" />
                  <Stat label="Ainda aguardando" value={a.ainda_aguardando} color="#F59E0B" tone={a.ainda_aguardando > 0 ? 'warn' : 'ok'} />
                  <Stat label="Auto-resolvidas" value={a.auto_resolvidas} color="rgba(255,255,255,0.5)" hint="cliente sinalizou ou timeout" />
                </CardRow>
              </Section>

              {/* Tasks */}
              <Section title="Tasks da equipe" icon={<CheckCircle2 size={14} />}>
                <CardRow>
                  <Stat label="Criadas" value={t.criadas} color="#3B82F6" />
                  <Stat label="Concluídas" value={t.concluidas} color="#10B981" />
                  <Stat label="Bloqueadas" value={t.bloqueadas} color="#ef4444" tone={t.bloqueadas > 0 ? 'warn' : 'ok'} />
                </CardRow>
              </Section>

              {/* Extratos */}
              <Section title="Extratos · Atrio Finance" icon={<FileText size={14} />}>
                {ex.error ? (
                  <div style={{
                    padding: 10, borderRadius: 6, fontSize: 12,
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                    color: '#ef4444',
                  }}>
                    Não consegui consultar Finance: {ex.error}
                  </div>
                ) : (
                  <>
                    <CardRow>
                      <Stat label="Recebidos hoje" value={ex.total} color="rgba(255,255,255,0.7)" />
                      <Stat label="Importados" value={ex.auto_importados} color="#10B981" />
                      <Stat
                        label="Em fila aprovação"
                        value={ex.em_fila_aprovacao}
                        color="#F59E0B"
                        tone={ex.em_fila_aprovacao > 0 ? 'warn' : 'ok'}
                        hint="precisa humano confirmar cliente/conta"
                      />
                    </CardRow>
                    {lista.length === 0 ? (
                      <p style={{ fontSize: 12, color: 'var(--ao-text-dim)', textAlign: 'center', padding: '12px 0' }}>
                        Nenhum extrato recebido hoje.
                      </p>
                    ) : (
                      <div style={{ marginTop: 10 }}>
                        {lista.map((it, i) => (
                          <ExtratoRow key={`${it.source}-${it.id}-${i}`} item={it} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </Section>

              {/* Briefing executivo via Rodrigo (LLM) */}
              <Section title="Briefing executivo · Rodrigo" icon={<Sparkles size={14} />}>
                {!narrative && !narrativeLoading && !narrativeError && (
                  <button
                    onClick={narrate}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: '1px solid var(--ao-border)',
                      background: 'var(--ao-card)',
                      color: 'var(--ao-text-secondary)',
                      cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                  >
                    <Sparkles size={13} />
                    Resumir o dia com Rodrigo
                  </button>
                )}
                {narrativeLoading && (
                  <div style={{
                    padding: 16, borderRadius: 8,
                    background: 'var(--ao-card)', border: '1px solid var(--ao-border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    color: 'var(--ao-text-dim)', fontSize: 12,
                  }}>
                    <Loader2 size={14} className="animate-spin" />
                    Rodrigo está analisando...
                  </div>
                )}
                {narrativeError && (
                  <div style={{
                    padding: 12, borderRadius: 8,
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                    color: '#ef4444', fontSize: 12,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <AlertCircle size={14} />
                    {narrativeError}
                    <button
                      onClick={narrate}
                      style={{
                        marginLeft: 'auto', padding: '3px 8px', fontSize: 10, fontWeight: 600,
                        borderRadius: 4, border: '1px solid rgba(239,68,68,0.3)',
                        background: 'transparent', color: '#ef4444', cursor: 'pointer',
                      }}
                    >
                      Tentar de novo
                    </button>
                  </div>
                )}
                {narrative && (
                  <div style={{
                    padding: '14px 16px', borderRadius: 8,
                    background: 'linear-gradient(135deg, rgba(196,149,106,0.06), rgba(196,149,106,0.02))',
                    border: '1px solid rgba(196,149,106,0.18)',
                    fontSize: 13, lineHeight: 1.55,
                    color: 'var(--ao-text-primary)',
                    whiteSpace: 'pre-wrap',
                    fontFamily: "'Space Grotesk', system-ui",
                  }}>
                    {narrative}
                    <button
                      onClick={narrate}
                      title="Gerar de novo"
                      style={{
                        marginTop: 10, padding: '4px 10px', fontSize: 10, fontWeight: 600,
                        borderRadius: 6, border: '1px solid var(--ao-border)',
                        background: 'transparent', color: 'var(--ao-text-dim)', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      <Sparkles size={10} /> Regerar
                    </button>
                  </div>
                )}
              </Section>

              <p style={{
                marginTop: 14, fontSize: 10, color: 'var(--ao-text-xs)', textAlign: 'center',
              }}>
                Gerado às {new Date(data.generated_at).toLocaleTimeString('pt-BR')}.
                Filtros: data do servidor (UTC).
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, icon, children }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <h3 style={{
        margin: '0 0 8px', fontSize: 11, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '.06em',
        color: 'var(--ao-text-dim)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function CardRow({ children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
      gap: 8,
    }}>
      {children}
    </div>
  )
}

function Stat({ label, value, color = 'rgba(255,255,255,0.7)', hint, tone }) {
  const v = (value === null || value === undefined) ? '-' : String(value)
  const bg = tone === 'warn'
    ? 'rgba(245, 158, 11, 0.06)'
    : 'var(--ao-card)'
  return (
    <div
      title={hint || ''}
      style={{
        padding: '10px 12px', borderRadius: 8,
        background: bg,
        border: '1px solid var(--ao-border)',
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: "'Space Grotesk', monospace", marginTop: 2 }}>
        {v}
      </div>
    </div>
  )
}

function ExtratoRow({ item }) {
  const isPending = item.source === 'pending'
  const color = isPending ? '#F59E0B' : '#10B981'
  const bg = isPending ? 'rgba(245, 158, 11, 0.06)' : 'rgba(16, 185, 129, 0.05)'
  const label = isPending ? 'aprovação' : 'importado'
  const time = item.createdAt ? new Date(item.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''
  const cliente = item.clienteId ? `cliente #${item.clienteId}` : (isPending ? 'cliente a confirmar' : '')
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 6, marginTop: 6,
      background: bg,
      border: `1px solid ${color}26`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: 'var(--ao-text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {item.filename || '(sem nome)'}
        </div>
        <div style={{ fontSize: 10, color: 'var(--ao-text-dim)', marginTop: 1 }}>
          <span style={{ color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            {label}
          </span>
          {item.transacoes !== null && item.transacoes !== undefined && !isPending && ` · ${item.transacoes} tx`}
          {cliente && ` · ${cliente}`}
          {time && ` · ${time}`}
          {item.recebidoNome && isPending && ` · de ${item.recebidoNome}`}
        </div>
        {item.motivo && isPending && (
          <div style={{ fontSize: 10, color: 'var(--ao-text-xs)', marginTop: 2, fontStyle: 'italic' }}>
            {item.motivo}
          </div>
        )}
      </div>
      <Clock size={12} style={{ color: 'var(--ao-text-dim)', flexShrink: 0 }} />
    </div>
  )
}
