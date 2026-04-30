import { useEffect, useState, useCallback } from 'react'
import { Users, TrendingUp, Sparkles, Snowflake, AlertCircle, CheckCircle2, Calendar, ArrowRight, MessageCircle, Send, Inbox, Clock } from 'lucide-react'

/**
 * Pagina Growth — Dashboard da Natalia.
 * Mostra:
 *   - KPIs da carteira (clientes ativos, MRR, prospects, novos 30d, frios 60d, etc.)
 *   - Pipeline da Natalia (tasks pendentes assigned_to=natalia agrupadas por origem)
 */
const NATALIA_ID = 'e0b37e09-d3cc-455a-a5c5-3a43d32d9cab'

export default function GrowthPage() {
  const [kpis, setKpis] = useState(null)
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [kRes, tRes] = await Promise.all([
        fetch('/api/growth/kpis').then(r => r.json()),
        fetch(`/api/tasks?assigned_to=${NATALIA_ID}&status=pending,in_progress&limit=100`).then(r => r.json()).catch(() => ({ data: [] })),
      ])
      if (!kRes.ok && !kRes.clientes_ativos) throw new Error(kRes.error || 'falha KPIs')
      setKpis(kRes)
      setTasks(Array.isArray(tRes) ? tRes : (tRes?.data || []))
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const fmtBRL = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })

  // Agrupa tasks por source
  const grupos = {}
  for (const t of tasks) {
    const src = t.result?.source || 'outros'
    if (!grupos[src]) grupos[src] = []
    grupos[src].push(t)
  }
  const grupoMeta = {
    natalia_health_check: { label: 'Clientes frios', desc: 'Sem entrega de docs ha 60d', Icon: Snowflake, color: '#3B82F6' },
    natalia_aniversario_cliente: { label: 'Aniversários', desc: '6m NPS / 12m+ reajuste', Icon: Calendar, color: '#F59E0B' },
    natalia_qualificar_leads: { label: 'Leads novos', desc: 'Prospects ultimos 7 dias', Icon: Sparkles, color: '#10B981' },
    natalia_upsell_oportunidades: { label: 'Upsell', desc: 'Oportunidades de expansao', Icon: TrendingUp, color: '#8B5CF6' },
    natalia_recuperacao: { label: 'Recuperacao', desc: 'Inativados ultimos 90d', Icon: AlertCircle, color: '#EF4444' },
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 18, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: 'var(--ao-text-primary)' }}>Growth</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ao-text-dim)' }}>
            Saúde da carteira, pipeline da Natalia e oportunidades de expansão
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '6px 12px', fontSize: 12, borderRadius: 8,
            border: '1px solid var(--ao-border)',
            background: 'var(--ao-card)', color: 'var(--ao-text-secondary)',
            cursor: 'pointer',
          }}
        >
          {loading ? 'Atualizando...' : 'Atualizar'}
        </button>
      </div>

      {error && (
        <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#EF4444', fontSize: 13 }}>
          Erro: {error}
        </div>
      )}

      {/* KPI Grid */}
      {kpis && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12, marginBottom: 24,
        }}>
          <KpiCard Icon={Users} color="#10B981" label="Clientes ativos" value={kpis.clientes_ativos} />
          <KpiCard Icon={TrendingUp} color="#8B5CF6" label="MRR" value={fmtBRL(kpis.mrr_brl)} sub="receita mensal recorrente" />
          <KpiCard Icon={Sparkles} color="#3B82F6" label="Prospects" value={kpis.prospects} sub="aguardando contato" />
          <KpiCard Icon={CheckCircle2} color="#06B6D4" label="Novos 30d" value={kpis.novos_30d} sub="entradas recentes" />
          <KpiCard Icon={Snowflake} color="#F59E0B" label="Clientes frios 60d" value={kpis.frios_60d ?? '?'} sub="sem entrega de docs" highlight={kpis.frios_60d > 30} />
          <KpiCard Icon={AlertCircle} color="#EF4444" label="Inativados 90d" value={kpis.inativos_90d} sub="oportunidade de recuperacao" />
        </div>
      )}

      {/* Conversao 30d */}
      {kpis?.natalia_30d && (
        <div style={{ marginBottom: 24, padding: 16, borderRadius: 12, background: 'var(--ao-card)', border: '1px solid var(--ao-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              <MessageCircle size={16} style={{ color: '#8B5CF6' }} />
              Conversão Natalia · últimos 30 dias
            </h2>
            {kpis.natalia_30d.taxa_resposta_pct != null && (
              <div style={{
                padding: '4px 12px', borderRadius: 100,
                background: kpis.natalia_30d.taxa_resposta_pct >= 30 ? 'rgba(16,185,129,0.15)'
                          : kpis.natalia_30d.taxa_resposta_pct >= 15 ? 'rgba(245,158,11,0.15)'
                          : 'rgba(239,68,68,0.15)',
                color: kpis.natalia_30d.taxa_resposta_pct >= 30 ? '#10B981'
                     : kpis.natalia_30d.taxa_resposta_pct >= 15 ? '#F59E0B'
                     : '#EF4444',
                fontSize: 12, fontWeight: 700,
              }}>
                {kpis.natalia_30d.taxa_resposta_pct}% taxa de resposta
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <MiniStat Icon={Send} color="#8B5CF6" label="Enviadas" value={kpis.natalia_30d.enviadas} />
            <MiniStat Icon={CheckCircle2} color="#10B981" label="Responderam" value={kpis.natalia_30d.respondidas} />
            <MiniStat Icon={Clock} color="#F59E0B" label="Aguardando" value={kpis.natalia_30d.aguardando} />
            <MiniStat Icon={Inbox} color="#64748B" label="Silent (5d+)" value={kpis.natalia_30d.silent} />
          </div>
        </div>
      )}

      {/* Pipeline Natalia */}
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Pipeline Natalia</h2>
        <span style={{ fontSize: 12, color: 'var(--ao-text-dim)' }}>
          {tasks.length} task(s) abertas
        </span>
      </div>

      {tasks.length === 0 && !loading && (
        <div style={{ padding: 30, textAlign: 'center', borderRadius: 12, background: 'var(--ao-card)', border: '1px solid var(--ao-border)', color: 'var(--ao-text-dim)' }}>
          Nenhuma task aberta. Aguarde os crons (Seg 08h, diário 09h, diário 10h).
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {Object.entries(grupos).map(([src, list]) => {
          const meta = grupoMeta[src] || { label: src, desc: '', Icon: Sparkles, color: '#64748B' }
          const Ic = meta.Icon
          return (
            <div key={src} style={{ borderRadius: 12, background: 'var(--ao-card)', border: '1px solid var(--ao-border)', overflow: 'hidden' }}>
              <div style={{
                padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10,
                background: `${meta.color}10`, borderBottom: '1px solid var(--ao-border)',
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: `${meta.color}22`, color: meta.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Ic size={16} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{meta.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--ao-text-dim)' }}>{meta.desc}</div>
                </div>
                <span style={{
                  padding: '3px 10px', borderRadius: 100, fontSize: 11, fontWeight: 700,
                  background: `${meta.color}22`, color: meta.color,
                }}>
                  {list.length}
                </span>
              </div>
              <div>
                {list.slice(0, 8).map(t => (
                  <a
                    key={t.id}
                    href={`/?task=${t.id}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 16px', borderBottom: '1px solid var(--ao-border)',
                      textDecoration: 'none', color: 'inherit',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ao-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.title}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)', marginTop: 2 }}>
                        {t.priority} · criada {new Date(t.created_at).toLocaleDateString('pt-BR')}
                        {t.result?.msg_sugerida && ' · ✉️ msg sugerida'}
                      </div>
                    </div>
                    <ArrowRight size={13} style={{ color: 'var(--ao-text-dim)' }} />
                  </a>
                ))}
                {list.length > 8 && (
                  <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--ao-text-dim)', textAlign: 'center' }}>
                    + {list.length - 8} task(s) mais
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MiniStat({ Icon, color, label, value }) {
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 8,
      background: 'var(--ao-bg)', border: '1px solid var(--ao-border)',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <div style={{
        width: 24, height: 24, borderRadius: 6,
        background: `${color}22`, color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={12} />
      </div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 10, color: 'var(--ao-text-dim)' }}>{label}</div>
      </div>
    </div>
  )
}

function KpiCard({ Icon, color, label, value, sub, highlight }) {
  return (
    <div style={{
      padding: 14, borderRadius: 12,
      background: highlight ? `${color}10` : 'var(--ao-card)',
      border: `1px solid ${highlight ? color + '44' : 'var(--ao-border)'}`,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 7,
          background: `${color}20`, color, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={14} />
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ao-text-dim)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ao-text-primary)', lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)' }}>{sub}</div>
      )}
    </div>
  )
}
