import { useEffect, useState } from 'react'
import { Shield, ShieldOff, Lock, Unlock, AlertTriangle, RefreshCw } from 'lucide-react'

/**
 * Pagina de Seguranca — kill-switch agente→cliente, audit de bloqueios.
 *
 * - Toggle pra ligar/desligar (com confirmacao quando vai LIBERAR — destrutivo)
 * - Stats: blocks 24h, 7d, all-time
 * - Lista de tentativas bloqueadas com texto sugerido + chat_id
 */
export default function SecurityPage() {
  const [status, setStatus] = useState(null)
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState(null)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const [s, b] = await Promise.all([
        fetch('/api/security/agent-outbound-status').then(r => r.json()),
        fetch('/api/security/agent-outbound-blocks?limit=100').then(r => r.json()),
      ])
      setStatus(s)
      setBlocks(b.blocks || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  const toggle = async () => {
    if (!status) return
    const willEnable = !status.agent_outbound_enabled
    if (willEnable) {
      const ok = window.confirm(
        '⚠️ ATENÇÃO\n\nIsso vai PERMITIR que agentes IA (Luna, Sneijder, Saldanha, Natalia) enviem mensagens diretas para clientes externos sem aprovação humana.\n\nTem certeza? Digite "LIBERAR" se quiser confirmar.'
      )
      if (!ok) return
      const word = window.prompt('Digite LIBERAR para confirmar:')
      if (word !== 'LIBERAR') return
    }
    setToggling(true)
    try {
      const r = await fetch('/api/security/agent-outbound-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: willEnable, by: 'caio' }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await load()
    } catch (e) { setError(e.message) }
    finally { setToggling(false) }
  }

  if (loading && !status) {
    return (
      <div style={{ padding: 24, color: 'var(--ao-text-dim)', textAlign: 'center' }}>
        <RefreshCw size={20} className="animate-spin" /> Carregando...
      </div>
    )
  }

  const active = status?.kill_switch_active
  const accent = active ? '#10B981' : '#EF4444'

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={22} style={{ color: 'var(--ao-accent, #6366F1)' }} />
          Segurança
        </h1>
        <p style={{ fontSize: 12, color: 'var(--ao-text-dim)', margin: '4px 0 0' }}>
          Kill-switch agente→cliente, audit de tentativas bloqueadas e configurações.
        </p>
      </div>

      {/* Status card */}
      <div style={{
        padding: 18, borderRadius: 14,
        background: active ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.10)',
        border: `2px solid ${accent}55`,
        marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 14,
            background: `${accent}22`, color: accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            {active ? <Lock size={22} /> : <Unlock size={22} />}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: accent }}>
                {active ? 'Kill-switch ATIVO' : '⚠️ Agentes LIBERADOS para clientes'}
              </h2>
            </div>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ao-text-secondary)', lineHeight: 1.5 }}>
              {active
                ? 'Agentes IA não conseguem enviar mensagens diretas para clientes externos. Tentativas são bloqueadas e redirecionadas pro grupo interno Luna_Atendimento como avisos.'
                : 'Agentes IA podem enviar mensagens diretas pra clientes sem aprovação humana. Reative o kill-switch se houver risco.'}
            </p>
            {status?.source === 'env' && (
              <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--ao-text-dim)' }}>
                Configurado via variável de ambiente (não pode ser desativado pela UI).
              </p>
            )}
            {status?.updated_by && status?.source === 'db' && (
              <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--ao-text-dim)' }}>
                Última alteração: {status.updated_by} em {new Date(status.updated_at).toLocaleString('pt-BR')}
              </p>
            )}
          </div>
          <button
            onClick={toggle}
            disabled={toggling || status?.source === 'env'}
            style={{
              padding: '10px 18px', fontSize: 12.5, fontWeight: 700, borderRadius: 10,
              border: 'none',
              background: active ? '#EF4444' : '#10B981',
              color: 'white',
              cursor: (toggling || status?.source === 'env') ? 'not-allowed' : 'pointer',
              opacity: status?.source === 'env' ? 0.5 : 1,
              flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
            title={status?.source === 'env' ? 'Travado pela env var' : ''}
          >
            {toggling ? <RefreshCw size={13} className="animate-spin" /> : (active ? <ShieldOff size={13} /> : <Shield size={13} />)}
            {active ? 'Liberar agentes' : 'Reativar kill-switch'}
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
        marginBottom: 18,
      }}>
        <StatBox label="Bloqueios 24h" value={status?.blocks_24h ?? 0} color="#F59E0B" />
        <StatBox label="Bloqueios 7 dias" value={status?.blocks_7d ?? 0} color="#8B5CF6" />
        <StatBox label="Total acumulado" value={status?.blocks_total ?? 0} color="#3B82F6" />
      </div>

      {error && (
        <div style={{
          padding: 12, borderRadius: 8, marginBottom: 12,
          background: 'rgba(239,68,68,0.12)', color: '#EF4444',
          border: '1px solid rgba(239,68,68,0.3)', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* Blocks list */}
      <div style={{ borderRadius: 12, border: '1px solid var(--ao-border)', background: 'var(--ao-card)', overflow: 'hidden' }}>
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--ao-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>Tentativas bloqueadas (últimas 100)</h3>
          <button
            onClick={load}
            disabled={loading}
            style={{
              padding: '5px 10px', fontSize: 11, borderRadius: 6,
              border: '1px solid var(--ao-border)', background: 'transparent',
              color: 'var(--ao-text-secondary)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Atualizar
          </button>
        </div>
        {blocks.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--ao-text-dim)', fontSize: 12.5 }}>
            Nenhuma tentativa bloqueada ainda. Bom sinal — significa que os agentes não estão tentando contatar clientes.
          </div>
        ) : (
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {blocks.map(b => (
              <div key={b.id} style={{
                padding: '10px 16px', borderBottom: '1px solid var(--ao-border)',
                display: 'flex', gap: 12, alignItems: 'flex-start',
              }}>
                <Lock size={14} style={{ color: '#EF4444', marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontFamily: 'Space Grotesk, monospace', color: 'var(--ao-text-secondary)' }}>
                      {String(b.chat_id).split('@')[0]}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--ao-text-dim)' }}>
                      {new Date(b.blocked_at).toLocaleString('pt-BR')}
                    </span>
                    {b.redirected_to_group && (
                      <span style={{
                        fontSize: 9, padding: '2px 6px', borderRadius: 4,
                        background: 'rgba(99,102,241,0.15)', color: '#6366F1',
                        fontWeight: 700, textTransform: 'uppercase',
                      }}>
                        redirecionado
                      </span>
                    )}
                  </div>
                  {b.suggested_text && (
                    <div style={{
                      fontSize: 12, color: 'var(--ao-text-primary)', lineHeight: 1.5,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      borderLeft: '2px solid var(--ao-border)', paddingLeft: 8,
                      maxHeight: 120, overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {b.suggested_text}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatBox({ label, value, color }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 10,
      background: 'var(--ao-card)', border: '1px solid var(--ao-border)',
    }}>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--ao-text-dim)', marginTop: 2 }}>{label}</div>
    </div>
  )
}
