import { useState, useEffect } from 'react'

export default function LunaHealthStrip() {
  const [h, setH] = useState(null)

  useEffect(() => {
    const load = () => fetch('/api/luna/health?days=7').then(r => r.json()).then(setH).catch(() => {})
    load()
    const i = setInterval(load, 30000)
    return () => clearInterval(i)
  }, [])

  if (!h) return null
  const { latencia_llm, mensagens, handoffs, reflector, buffer } = h
  const p95 = latencia_llm?.p95_ms
  const p95Color = !p95 ? '#64748b' : p95 < 2500 ? '#22c55e' : p95 < 5000 ? '#f59e0b' : '#ef4444'

  const Item = ({ label, value, color = 'var(--ao-text-primary)', sub }) => (
    <div className="flex flex-col min-w-[90px]">
      <span className="text-[10px]" style={{ color: 'var(--ao-text-dim)' }}>{label}</span>
      <span className="text-sm font-semibold tabular-nums" style={{ color, fontFamily: 'Outfit' }}>
        {value ?? '—'}{sub && <span className="text-[10px] font-normal ml-1" style={{ color: 'var(--ao-text-dim)' }}>{sub}</span>}
      </span>
    </div>
  )

  return (
    <div className="glass-card rounded-xl px-4 py-3 flex items-center gap-5 flex-wrap">
      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--ao-text-dim)' }}>Luna · 7d</span>
      <Item label="p50 LLM" value={latencia_llm?.p50_ms ? latencia_llm.p50_ms + 'ms' : null} />
      <Item label="p95 LLM" value={p95 ? p95 + 'ms' : null} color={p95Color} />
      <Item label="Respostas" value={latencia_llm?.respostas_amostradas || 0} />
      <Item label="Tool calls" value={latencia_llm?.total_tool_calls || 0} />
      <Item label="Mensagens" value={`${mensagens?.inbound || 0}/${mensagens?.outbound || 0}`} sub="in/out" />
      <Item label="Conversas" value={mensagens?.conversas_ativas || 0} />
      <Item label="Handoffs" value={(handoffs?.inercias || 0) + (handoffs?.vagas || 0)} color={((handoffs?.inercias || 0) + (handoffs?.vagas || 0)) > 0 ? '#f59e0b' : 'var(--ao-text-primary)'} />
      <Item label="Memórias pend" value={reflector?.memorias_pendentes || 0} color={(reflector?.memorias_pendentes || 0) > 0 ? '#84cc16' : 'var(--ao-text-primary)'} />
      <Item label="Buffer" value={buffer?.ativos_agora || 0} sub="ativos" />
    </div>
  )
}
