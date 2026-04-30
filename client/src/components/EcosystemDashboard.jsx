import { useEffect, useMemo, useState } from 'react'
import {
  Loader2, Users, Wallet, FileText, MessageCircle, Package,
  Upload, Clock, AlertTriangle, TrendingUp, Activity, ExternalLink, ChevronDown, ChevronRight,
} from 'lucide-react'

// URL base do Gesthub — deep-link pro Client360
const GESTHUB_URL = 'http://31.97.175.200'
const openClient360 = (clientId, tab = 'timeline') => {
  if (!clientId) return
  const url = `${GESTHUB_URL}/?client=${clientId}&tab=${tab}`
  window.open(url, '_blank', 'noopener')
}

/**
 * Ecossistema — dashboard cross-system.
 * Mostra cobertura por sistema, atividade recente e gaps.
 * Fonte: /api/datalake/ecossistema (agregacao via FDW).
 */
export default function EcosystemDashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async () => {
    try {
      const r = await fetch('/api/datalake/ecossistema')
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'erro')
      setData(j.data)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 2 * 60 * 1000)  // refresh 2min
    return () => clearInterval(t)
  }, [])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-20 opacity-60">
        <Loader2 className="animate-spin" size={24} />
      </div>
    )
  }

  if (error) return <div className="text-sm text-red-500 p-4">Erro: {error}</div>
  if (!data) return null

  const k = data.kpis || {}
  const cov = data.cobertura || {}
  const dist = data.distribuicaoPorSistemas || {}
  const gaps = data.gaps || {}

  const formatBRL = (v) =>
    Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  const formatDate = (d) => {
    if (!d) return '--'
    try { return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }
    catch { return String(d).slice(0, 16) }
  }

  return (
    <div className="flex flex-col gap-5 p-5" style={{ color: 'var(--ao-text)' }}>
      {/* Header */}
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: '-0.5px' }}>
          Ecossistema Átrio
        </h1>
        <p style={{ fontSize: 12.5, opacity: 0.65, margin: '4px 0 0' }}>
          Panorama dos 4 sistemas — Gesthub, Finance, NFS-e e Luna
        </p>
      </div>

      {/* KPIs topo: totais globais */}
      <section>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <KpiCard icon={<Users size={18} />} title="Clientes ativos"
                   value={k.ativos ?? '--'} subtitle={`de ${k.totalClientes || 0} na Carteira`} color="#6366f1" />
          <KpiCard icon={<Wallet size={18} />} title="Movimento financeiro"
                   value={formatBRL(k.financeCreditos)} subtitle={`${k.totalTransacoes || 0} transações · ${k.totalUploads || 0} extratos`} color="#10b981" />
          <KpiCard icon={<FileText size={18} />} title="NFS-e emitidas"
                   value={k.nfseEmitidas ?? 0} subtitle={k.nfsePendentes ? `${k.nfsePendentes} aguardando envio` : 'tudo em dia'}
                   subtitleWarn={k.nfsePendentes > 0} color="#3b82f6" />
          <KpiCard icon={<Package size={18} />} title="Fornecedores"
                   value={k.totalFornecedores ?? '--'} subtitle="identificados automaticamente" color="#f59e0b" />
          <KpiCard icon={<MessageCircle size={18} />} title="Luna ativa"
                   value={k.comLuna ?? 0} subtitle="clientes conversando por WhatsApp" color="#8b5cf6" />
        </div>
      </section>

      {/* Cobertura por sistema (%) */}
      <section>
        <SectionHeader title="Onde cada cliente está" subtitle={`Dos ${k.ativos || 0} clientes ativos, quantos já usam cada sistema`} />
        <div className="grid gap-3 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <CoverageBar label="Atrio Finance" color="#10b981" cov={cov.finance} total={k.ativos} />
          <CoverageBar label="NFS-e" color="#3b82f6" cov={cov.nfse} total={k.ativos} />
          <CoverageBar label="Fornecedores" color="#f59e0b" cov={cov.fornecedores} total={k.ativos} />
          <CoverageBar label="Luna (WhatsApp)" color="#8b5cf6" cov={cov.luna} total={k.ativos} />
        </div>
      </section>

      {/* Distribuição por qtd de sistemas */}
      <section>
        <SectionHeader title="Penetração dos sistemas" subtitle="Quantos sistemas cada cliente ativo já está usando" />
        <div className="grid grid-cols-4 gap-3 mt-2">
          <DistributionCard label="Sem integração" value={dist.zero} color="#ef4444" total={k.ativos} />
          <DistributionCard label="1 sistema" value={dist.um} color="#f59e0b" total={k.ativos} />
          <DistributionCard label="2 sistemas" value={dist.dois} color="#10b981" total={k.ativos} />
          <DistributionCard label="3 sistemas" value={dist.tres} color="#6366f1" total={k.ativos} />
        </div>
      </section>

      {/* Duas colunas: Atividade + Gaps */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
        {/* Atividade recente */}
        <section>
          <SectionHeader title="Atividade recente" subtitle="Uploads de extrato e NFS-e emitidas nos últimos dias" icon={<Activity size={14} />} />
          <div className="flex flex-col gap-2 mt-2">
            {(data.atividadeRecente || []).length === 0 ? (
              <EmptyHint>Nenhuma atividade nos últimos dias.</EmptyHint>
            ) : (
              (data.atividadeRecente || []).map((e, i) => (
                <ActivityRow key={i} ev={e} formatDate={formatDate} formatBRL={formatBRL} />
              ))
            )}
          </div>
        </section>

        {/* Gaps + Top clientes */}
        <section className="flex flex-col gap-4">
          {/* Top clientes */}
          <div>
            <SectionHeader title="Clientes mais integrados" subtitle="Os que já usam mais sistemas" icon={<TrendingUp size={14} />} />
            <div className="flex flex-col gap-1.5 mt-2">
              {(data.topClientes || []).length === 0 ? (
                <EmptyHint>Nenhum cliente com dados em mais de 1 sistema ainda.</EmptyHint>
              ) : (
                (data.topClientes || []).slice(0, 5).map((c, i) => (
                  <TopClienteRow key={c.id} c={c} />
                ))
              )}
            </div>
          </div>

          {/* Gaps */}
          <div>
            <SectionHeader title="Oportunidades" subtitle={`${gaps.count || 0} cliente${gaps.count === 1 ? '' : 's'} ativo${gaps.count === 1 ? '' : 's'} sem integração em nenhum sistema — candidatos a onboarding`} icon={<AlertTriangle size={14} />} />
            <div className="mt-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--ao-border)' }}>
              {(gaps.ativosSemDados || []).length === 0 ? (
                <EmptyHint>Todos os ativos têm pelo menos 1 sistema ligado. 🎯</EmptyHint>
              ) : (
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {(gaps.ativosSemDados || []).slice(0, 30).map(g => (
                    <div
                      key={g.id}
                      onClick={() => openClient360(g.id, 'timeline')}
                      title="Abrir Cliente 360 no Gesthub"
                      className="px-3 py-1.5 text-xs flex items-center justify-between cursor-pointer hover:bg-[var(--ao-bg-soft)] transition-colors group"
                      style={{ borderBottom: '1px solid var(--ao-border)' }}>
                      <span style={{ fontWeight: 600 }}>{g.legal_name || g.trade_name || '--'}</span>
                      <span className="flex items-center gap-1.5">
                        <span style={{ opacity: 0.55, fontFamily: 'monospace', fontSize: 10 }}>#{g.id}</span>
                        <ExternalLink size={10} className="opacity-0 group-hover:opacity-70 transition-opacity" />
                      </span>
                    </div>
                  ))}
                  {gaps.count > 30 && (
                    <div className="px-3 py-2 text-[11px]" style={{ opacity: 0.6, textAlign: 'center' }}>
                      +{gaps.count - 30} outros clientes sem cobertura
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Learnings health */}
      {data.learnings && (
        <section>
          <SectionHeader title="Datalake · Learnings" subtitle="saúde do back-sync entre sistemas" />
          <div className="grid gap-3 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            {Object.entries(data.learnings.porStatus || {}).map(([status, n]) => (
              <div key={status} style={{ padding: '14px 10px', borderRadius: 12, textAlign: 'center', border: '1px solid var(--ao-border)', background: 'var(--ao-bg-soft)' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: statusColor(status) }}>{n}</div>
                <div style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.7, letterSpacing: 0.5 }}>{status}</div>
              </div>
            ))}
            {data.learnings.pendentesAntigos7d > 0 && (
              <div style={{ padding: '14px 10px', borderRadius: 12, textAlign: 'center', border: '1px solid #f5930033', background: '#f5930015' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#f59e0b' }}>{data.learnings.pendentesAntigos7d}</div>
                <div style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.85, color: '#f59e0b', letterSpacing: 0.5 }}>pendentes &gt;7d</div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Sanity sweep — normalização automática */}
      {data.sanity && (
        <SanitySection sanity={data.sanity} onRefresh={load} />
      )}

      {/* Tasks bloqueadas — visibilidade ativa de falhas do orchestrator */}
      {data.tasksBloqueadas && data.tasksBloqueadas.total > 0 && (
        <TasksBloqueadasSection data={data.tasksBloqueadas} onRefresh={load} />
      )}

      <div className="h-4" />
    </div>
  )
}

function TasksBloqueadasSection({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(true)
  const total = data.total || 0
  const porTipo = data.porTipo || {}
  const recentes = data.recentes || []

  const formatAgo = (secs) => {
    if (!secs) return ''
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}min`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`
    return `${Math.floor(secs / 86400)}d`
  }

  const tipoLabels = {
    loop: { label: 'Loop de IA (>10 tool calls)', color: '#ef4444', icon: '🔁' },
    api_externa: { label: 'API externa caiu', color: '#f59e0b', icon: '🌐' },
    dados_invalidos: { label: 'Dados inválidos (CPF/CNPJ)', color: '#8b5cf6', icon: '❌' },
    tool_falhou: { label: 'Tool falhou', color: '#f97316', icon: '🛠️' },
    outros: { label: 'Outros erros', color: '#6b7280', icon: '⚠️' },
  }

  return (
    <section>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 700, margin: 0, letterSpacing: '-0.2px', color: '#ef4444' }}>
            <AlertTriangle size={14} />
            Tasks bloqueadas · {total}
          </h3>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
            falhas do orchestrator que precisam intervenção humana
          </div>
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="px-3 py-1.5 rounded-md text-xs font-semibold"
          style={{ background: 'var(--ao-bg-soft)', border: '1px solid var(--ao-border)' }}
        >
          {expanded ? 'Recolher' : 'Expandir'}
        </button>
      </div>

      {/* Resumo por tipo de erro */}
      <div className="grid gap-2 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        {Object.entries(porTipo).filter(([, n]) => n > 0).map(([tipo, n]) => {
          const info = tipoLabels[tipo] || tipoLabels.outros
          return (
            <div key={tipo} className="px-3 py-2 rounded-lg"
                 style={{ border: `1px solid ${info.color}33`, background: `${info.color}0a` }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: info.color }}>{info.icon} {n}</div>
              <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{info.label}</div>
            </div>
          )
        })}
      </div>

      {/* Lista de tasks recentes bloqueadas */}
      {expanded && recentes.length > 0 && (
        <div className="mt-3 rounded-lg overflow-hidden" style={{ border: '1px solid #ef444433' }}>
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider"
               style={{ background: '#ef444415', color: '#ef4444' }}>
            {Math.min(recentes.length, 10)} mais recentes
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {recentes.map((t, i) => (
              <div key={t.id} className="px-3 py-2 text-xs"
                   style={{ borderBottom: i < recentes.length - 1 ? '1px solid var(--ao-border)' : 'none' }}>
                <div className="flex items-center justify-between">
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                    {t.title}
                  </div>
                  <div className="flex items-center gap-2" style={{ fontSize: 10, opacity: 0.65 }}>
                    <span>{t.assigned_name || '?'}</span>
                    <span>·</span>
                    <span style={{ color: t.segundos_bloqueada > 3600 ? '#ef4444' : 'inherit' }}>
                      há {formatAgo(t.segundos_bloqueada)}
                    </span>
                  </div>
                </div>
                {t.erro && (
                  <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2, opacity: 0.85 }}>
                    {(t.erro || '').slice(0, 140)}{t.erro?.length > 140 ? '…' : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ================== Subcomponentes ==================

function KpiCard({ icon, title, value, subtitle, subtitleWarn, color }) {
  return (
    <div style={{
      padding: 14, borderRadius: 14,
      border: '1px solid var(--ao-border)', background: 'var(--ao-bg-soft)',
      display: 'flex', flexDirection: 'column', gap: 6,
      transition: 'transform 0.15s, box-shadow 0.15s',
    }}>
      <div className="flex items-center gap-2" style={{ color }}>
        <div style={{
          width: 30, height: 30, borderRadius: 9,
          background: color + '15', color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {icon}
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ao-text-secondary)' }}>
          {title}
        </span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.7px', color: 'var(--ao-text-primary)', lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, opacity: subtitleWarn ? 1 : 0.6, color: subtitleWarn ? '#f59e0b' : 'inherit' }}>
        {subtitle}
      </div>
    </div>
  )
}

function SectionHeader({ title, subtitle, icon }) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <h3 className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 700, margin: 0, letterSpacing: '-0.2px' }}>
          {icon}
          {title}
        </h3>
        {subtitle && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{subtitle}</div>}
      </div>
    </div>
  )
}

function CoverageBar({ label, color, cov, total }) {
  if (!cov) return (
    <div style={{ padding: 14, borderRadius: 14, border: '1px solid var(--ao-border)', background: 'var(--ao-bg-soft)', opacity: 0.6 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>sem dados</div>
    </div>
  )
  const percent = cov.percent || 0
  return (
    <div style={{ padding: 14, borderRadius: 14, border: '1px solid var(--ao-border)', background: 'var(--ao-bg-soft)' }}>
      <div className="flex items-center justify-between">
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color }}>
          {cov.count} {cov.count === 1 ? 'cliente' : 'clientes'} <span style={{ opacity: 0.6 }}>({percent}%)</span>
        </span>
      </div>
      <div style={{ marginTop: 9, borderRadius: 99, overflow: 'hidden', height: 7, background: 'var(--ao-bg)', border: '1px solid var(--ao-border)' }}>
        <div style={{ width: `${Math.min(percent, 100)}%`, height: '100%', background: `linear-gradient(90deg, ${color}, ${color}cc)`, transition: 'width 0.6s cubic-bezier(0.22, 1, 0.36, 1)' }} />
      </div>
    </div>
  )
}

function DistributionCard({ label, value, color, total }) {
  const pct = total ? Math.round(((value || 0) / total) * 100) : 0
  const hasValue = (value || 0) > 0
  return (
    <div style={{
      padding: '16px 12px', borderRadius: 14, textAlign: 'center',
      border: `1px solid ${hasValue ? color + '40' : 'var(--ao-border)'}`,
      background: hasValue ? `${color}0d` : 'var(--ao-bg-soft)',
      transition: 'transform 0.15s',
    }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: hasValue ? color : 'var(--ao-text-dim)', lineHeight: 1, letterSpacing: '-0.5px' }}>
        {value || 0}
      </div>
      <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 6, color: 'var(--ao-text-secondary)' }}>
        {label}
      </div>
      {hasValue && (
        <div style={{ fontSize: 10.5, opacity: 0.55, marginTop: 2 }}>
          {pct}% dos ativos
        </div>
      )}
    </div>
  )
}

function ActivityRow({ ev, formatDate, formatBRL }) {
  const isUpload = ev.tipo === 'upload'
  const icon = isUpload ? <Upload size={14} /> : <FileText size={14} />
  const iconColor = isUpload ? '#10b981' : '#3b82f6'
  const iconBg = isUpload ? '#10b98115' : '#3b82f615'
  const targetTab = isUpload ? 'financeiro' : 'nfse'
  const clickable = !!ev.cliente_id
  return (
    <div
      onClick={clickable ? () => openClient360(ev.cliente_id, targetTab) : undefined}
      title={clickable ? `Abrir ${ev.cliente_nome || 'cliente'} no Gesthub` : ''}
      className={`flex items-center gap-3 group transition-colors ${clickable ? 'cursor-pointer hover:border-[var(--ao-border-hover,rgba(255,255,255,0.15))]' : ''}`}
      style={{ border: '1px solid var(--ao-border)', background: 'var(--ao-bg-soft)', padding: '10px 12px', borderRadius: 12 }}>
      <div className="shrink-0 flex items-center justify-center rounded-md" style={{ width: 28, height: 28, background: iconBg, color: iconColor }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ev.titulo || '--'}
        </div>
        <div style={{ fontSize: 11, opacity: 0.65 }}>
          {ev.cliente_nome || '--'} · {formatDate(ev.data)}
          {isUpload && ev.valor ? ` · ${ev.valor} tx` : ''}
          {!isUpload && ev.valor ? ` · ${formatBRL(ev.valor)}` : ''}
          {ev.extra ? ` · ${ev.extra}` : ''}
        </div>
      </div>
      {clickable && <ExternalLink size={12} className="opacity-0 group-hover:opacity-60 transition-opacity" />}
    </div>
  )
}

function TopClienteRow({ c }) {
  const stopPropOpen = (tab) => (e) => {
    e.stopPropagation()
    openClient360(c.id, tab)
  }
  return (
    <div
      onClick={() => openClient360(c.id, 'timeline')}
      title="Clique para abrir Cliente 360"
      className="flex items-center justify-between text-xs cursor-pointer hover:border-[var(--ao-border-hover,rgba(255,255,255,0.15))] group transition-colors"
      style={{ border: '1px solid var(--ao-border)', background: 'var(--ao-bg-soft)', padding: '8px 12px', borderRadius: 10 }}>
      <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
        {c.legal_name || c.trade_name || `#${c.id}`}
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        {c.finance_tx > 0 && (
          <span onClick={stopPropOpen('financeiro')} title="Abrir aba Financeiro">
            <Pill letter="F" count={c.finance_tx} color="#10b981" />
          </span>
        )}
        {c.nfse_total > 0 && (
          <span onClick={stopPropOpen('nfse')} title="Abrir aba NFS-e">
            <Pill letter="N" count={c.nfse_total} color="#3b82f6" />
          </span>
        )}
        <span style={{ fontSize: 10, opacity: 0.6 }}>{c.sistemas || 0}x</span>
        <ExternalLink size={10} className="opacity-0 group-hover:opacity-70 transition-opacity" />
      </span>
    </div>
  )
}

function Pill({ letter, count, color }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 22, height: 16, padding: '0 4px', borderRadius: 8,
        fontSize: 9, fontWeight: 800, background: `${color}22`, color, border: `1px solid ${color}55`,
      }}
    >
      {letter}{count != null ? <span style={{ marginLeft: 2, opacity: 0.85 }}>{count}</span> : null}
    </span>
  )
}

function EmptyHint({ children }) {
  return (
    <div style={{
      padding: '16px 12px', borderRadius: 14, textAlign: 'center',
      border: '1px dashed var(--ao-border)',
      fontSize: 12, opacity: 0.55, color: 'var(--ao-text-secondary)',
    }}>
      {children}
    </div>
  )
}

function SanitySection({ sanity, onRefresh }) {
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState(null)
  const [expandedDocs, setExpandedDocs] = useState(false)
  const [expandedDup, setExpandedDup] = useState(false)

  const runSweep = async () => {
    setRunning(true)
    setMessage(null)
    try {
      const resp = await fetch('/api/datalake/sanity-run', { method: 'POST' })
      const j = await resp.json()
      if (j.ok) {
        setMessage(`✓ Aplicadas ${j.data?.totais?.correcoesAplicadas || 0} correções`)
        onRefresh?.()
      } else {
        setMessage(`✗ ${j.error || 'erro'}`)
      }
    } catch (e) {
      setMessage(`✗ ${e.message}`)
    } finally {
      setRunning(false)
      setTimeout(() => setMessage(null), 4000)
    }
  }

  const aplicadas = sanity.correcoesAplicadas || 0
  const issues = sanity.issuesParaRevisar || 0
  const ranAt = sanity.ranAt
  const mode = sanity.mode
  const docsList = sanity.documentosInvalidosList || []
  const dupList = sanity.contatosDuplicadosList || []

  return (
    <section>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 700, margin: 0, letterSpacing: '-0.2px' }}>
            <AlertTriangle size={14} />
            Sanity · normalização automática
          </h3>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
            {ranAt ? (
              <>último sweep: {new Date(ranAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                · modo: <span style={{ textTransform: 'uppercase', opacity: 0.85 }}>{mode}</span></>
            ) : 'nunca executado'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {message && <span style={{ fontSize: 11, opacity: 0.85 }}>{message}</span>}
          <button
            onClick={runSweep}
            disabled={running}
            className="px-3 py-1.5 rounded-md text-xs font-semibold"
            style={{
              background: running ? 'var(--ao-bg-soft)' : '#6366f1',
              color: running ? 'var(--ao-text)' : 'white',
              border: '1px solid var(--ao-border)',
              cursor: running ? 'wait' : 'pointer',
            }}
          >
            {running ? 'Rodando...' : 'Rodar sweep'}
          </button>
        </div>
      </div>
      <div className="grid gap-3 mt-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div style={{ padding: '14px 10px', borderRadius: 12, textAlign: 'center', border: aplicadas > 0 ? '1px solid #10b98133' : '1px solid var(--ao-border)', background: aplicadas > 0 ? '#10b98115' : 'var(--ao-bg-soft)' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: aplicadas > 0 ? '#10b981' : 'inherit' }}>{aplicadas}</div>
          <div style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.75, letterSpacing: 0.5 }}>correções aplicáveis</div>
        </div>
        <div style={{ padding: '14px 10px', borderRadius: 12, textAlign: 'center', border: issues > 0 ? '1px solid #f5930033' : '1px solid var(--ao-border)', background: issues > 0 ? '#f5930015' : 'var(--ao-bg-soft)' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: issues > 0 ? '#f59e0b' : 'inherit' }}>{issues}</div>
          <div style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.75, letterSpacing: 0.5 }}>issues p/ revisar</div>
        </div>
        {/* Documentos invalidos — clicavel pra expandir */}
        <div
          onClick={() => docsList.length > 0 && setExpandedDocs(v => !v)}
          className={`px-3 py-2 rounded-lg text-center transition-colors ${docsList.length > 0 ? 'cursor-pointer hover:opacity-90' : ''}`}
          style={{ border: sanity.docsInvalidos > 0 ? '1px solid #ef444433' : '1px solid var(--ao-border)', background: sanity.docsInvalidos > 0 ? '#ef444415' : 'var(--ao-bg-soft)' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: sanity.docsInvalidos > 0 ? '#ef4444' : 'inherit' }}>{sanity.docsInvalidos || 0}</div>
          <div className="flex items-center justify-center gap-1" style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.75, letterSpacing: 0.5 }}>
            CNPJ/CPF inválidos
            {docsList.length > 0 && (expandedDocs ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
          </div>
        </div>
        <div
          onClick={() => dupList.length > 0 && setExpandedDup(v => !v)}
          className={`px-3 py-2 rounded-lg text-center transition-colors ${dupList.length > 0 ? 'cursor-pointer hover:opacity-90' : ''}`}
          style={{ border: sanity.duplicados > 0 ? '1px solid #f5930033' : '1px solid var(--ao-border)', background: sanity.duplicados > 0 ? '#f5930015' : 'var(--ao-bg-soft)' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: sanity.duplicados > 0 ? '#f59e0b' : 'inherit' }}>{sanity.duplicados || 0}</div>
          <div className="flex items-center justify-center gap-1" style={{ fontSize: 10, textTransform: 'uppercase', opacity: 0.75, letterSpacing: 0.5 }}>
            contatos duplicados
            {dupList.length > 0 && (expandedDup ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
          </div>
        </div>
      </div>

      {/* Expanded: CNPJ/CPF inválidos */}
      {expandedDocs && docsList.length > 0 && (
        <div className="mt-2 rounded-lg overflow-hidden" style={{ border: '1px solid #ef444433' }}>
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ background: '#ef444415', color: '#ef4444' }}>
            Documentos com DV inválido — revisar no Gesthub
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {docsList.map((d, i) => (
              <div
                key={i}
                onClick={() => openClient360(d.cliente_id, 'timeline')}
                title="Abrir cliente no Gesthub pra corrigir CNPJ/CPF"
                className="px-3 py-2 text-xs flex items-center justify-between cursor-pointer hover:bg-[var(--ao-bg-soft)] group transition-colors"
                style={{ borderBottom: i < docsList.length - 1 ? '1px solid var(--ao-border)' : 'none' }}>
                <div className="min-w-0 flex-1">
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.legal_name || `Cliente #${d.cliente_id}`}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.7, fontFamily: 'monospace' }}>
                    {d.documento} · <span style={{ color: '#ef4444' }}>{d.motivo}</span>
                  </div>
                </div>
                <ExternalLink size={12} className="shrink-0 opacity-40 group-hover:opacity-80 transition-opacity" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expanded: contatos duplicados */}
      {expandedDup && dupList.length > 0 && (
        <div className="mt-2 rounded-lg overflow-hidden" style={{ border: '1px solid #f5930033' }}>
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ background: '#f5930015', color: '#f59e0b' }}>
            Contatos duplicados por CPF — revisar aba Contatos do cliente
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {dupList.map((d, i) => (
              <div
                key={i}
                onClick={() => openClient360(d.cliente_id, 'contatos')}
                title="Abrir aba Contatos pra resolver duplicata"
                className="px-3 py-2 text-xs cursor-pointer hover:bg-[var(--ao-bg-soft)] group transition-colors"
                style={{ borderBottom: i < dupList.length - 1 ? '1px solid var(--ao-border)' : 'none' }}>
                <div className="flex items-center justify-between">
                  <span style={{ fontWeight: 600 }}>Cliente #{d.cliente_id}</span>
                  <ExternalLink size={12} className="opacity-40 group-hover:opacity-80 transition-opacity" />
                </div>
                <div style={{ fontSize: 10, opacity: 0.7, fontFamily: 'monospace' }}>
                  CPF {d.cpf} · {(d.nomes || []).join(' / ')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(aplicadas === 0 && issues === 0) && (
        <div style={{ fontSize: 11, opacity: 0.55, textAlign: 'center', marginTop: 8 }}>
          🎯 Base limpa — nenhum problema detectado no último sweep.
        </div>
      )}
    </section>
  )
}

function statusColor(status) {
  switch (status) {
    case 'applied': return '#10b981'
    case 'proposed': return '#3b82f6'
    case 'rejected': return '#6b7280'
    case 'error': return '#ef4444'
    case 'stale': return '#f59e0b'
    default: return '#6b7280'
  }
}
