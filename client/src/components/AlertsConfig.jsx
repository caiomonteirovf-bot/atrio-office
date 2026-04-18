import { useState, useEffect } from 'react'
import { Bell, Save, Loader2, AlertCircle, RefreshCw, Zap, Clock, Users, Phone } from 'lucide-react'

const SEV_COLOR = {
  normal:   '#eab308',
  atencao:  '#f59e0b',
  critico:  '#ef4444',
  urgente:  '#dc2626',
  grave:    '#991b1b',
}

export default function AlertsConfig() {
  const [cfg, setCfg] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState(null)
  const [candidates, setCandidates] = useState([])

  const load = async () => {
    setLoading(true)
    try {
      const [c, a] = await Promise.all([
        fetch('/api/alerts/config').then(r => r.json()),
        fetch('/api/alerts/auto-resolve/candidates').then(r => r.json()),
      ])
      setCfg({ levels: c.levels || [], meta: c.meta || {} })
      setCandidates(a.data || [])
      setDirty(false)
    } catch (e) { setMsg({ type: 'err', text: e.message }) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const updateLevel = (level, patch) => {
    setCfg(c => ({
      ...c,
      levels: c.levels.map(l => l.level === level ? { ...l, ...patch } : l),
    }))
    setDirty(true)
  }

  const updateMeta = (key, value) => {
    setCfg(c => ({ ...c, meta: { ...c.meta, [key]: value } }))
    setDirty(true)
  }

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      await fetch('/api/alerts/config/levels', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ levels: cfg.levels }),
      }).then(r => r.json())
      await fetch('/api/alerts/config/meta', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: cfg.meta }),
      }).then(r => r.json())
      setMsg({ type: 'ok', text: 'Configuração salva. Mudanças valem para próximas escalations.' })
      setDirty(false)
    } catch (e) { setMsg({ type: 'err', text: e.message }) }
    finally { setSaving(false) }
  }

  const runAutoResolve = async () => {
    try {
      const r = await fetch('/api/alerts/auto-resolve/run', { method: 'POST' }).then(r => r.json())
      setMsg({ type: 'ok', text: `${r.resolved || 0} conversa(s) auto-resolvida(s).` })
      load()
    } catch (e) { setMsg({ type: 'err', text: e.message }) }
  }

  if (loading) return <div className="flex items-center justify-center py-10 opacity-60"><Loader2 className="animate-spin" /></div>
  if (!cfg) return null

  const fmtDuration = (min) => {
    if (min < 60) return `${min}min`
    if (min % 60 === 0) return `${min/60}h`
    return `${Math.floor(min/60)}h${min%60}`
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Banner de status */}
      {msg && (
        <div className="rounded p-3 text-sm flex items-start gap-2" style={{
          background: msg.type === 'err' ? 'color-mix(in oklab, red 10%, var(--ao-surface))' : 'color-mix(in oklab, green 10%, var(--ao-surface))',
          border: `1px solid ${msg.type === 'err' ? 'rgb(239 68 68)' : 'rgb(34 197 94)'}`,
        }}>
          <AlertCircle size={16} style={{ color: msg.type === 'err' ? 'rgb(239 68 68)' : 'rgb(34 197 94)', marginTop: 2 }} />
          <div className="flex-1">{msg.text}</div>
          <button onClick={() => setMsg(null)} className="opacity-60 hover:opacity-100 text-xs">✕</button>
        </div>
      )}

      {/* Ação bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button onClick={load} className="flex items-center gap-1 px-3 py-1.5 rounded text-xs"
            style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
            <RefreshCw size={12} /> Atualizar
          </button>
          {dirty && <span className="text-xs opacity-60">mudanças não salvas</span>}
        </div>
        <button onClick={save} disabled={!dirty || saving}
          className="flex items-center gap-1 px-4 py-1.5 rounded text-xs disabled:opacity-40"
          style={{ background: 'var(--ao-accent)', color: 'white', fontWeight: 600 }}>
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {saving ? 'Salvando...' : 'Salvar'}
        </button>
      </div>

      {/* Meta config */}
      <div className="rounded-lg p-4" style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold">
          <Zap size={14} /> Configurações gerais
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <MetaField icon={Clock} label="Auto-resolver após (horas)" type="number"
            value={cfg.meta.auto_resolve_hours || '48'} onChange={v => updateMeta('auto_resolve_hours', v)}
            hint="Tempo adicional após nível 6 (24h) antes de marcar conversa como resolvida" />
          <MetaField icon={Users} label="Nome do grupo WhatsApp"
            value={cfg.meta.notify_group_name || ''} onChange={v => updateMeta('notify_group_name', v)} />
          <MetaField icon={Clock} label="Início horário comercial" type="number"
            value={cfg.meta.business_hours_start || '8'} onChange={v => updateMeta('business_hours_start', v)}
            hint="Hora (0-23)" />
          <MetaField icon={Clock} label="Fim horário comercial" type="number"
            value={cfg.meta.business_hours_end || '18'} onChange={v => updateMeta('business_hours_end', v)}
            hint="Hora (0-23)" />
          <MetaField icon={Phone} label="Telefone de contato (nas mensagens)"
            value={cfg.meta.contact_phone || ''} onChange={v => updateMeta('contact_phone', v)} />
          <div>
            <label className="text-xs opacity-70 flex items-center gap-1 mb-1">
              <Bell size={12} /> Adiar alerta de 1º contato
            </label>
            <select value={cfg.meta.first_contact_alert_delayed || 'true'}
              onChange={e => updateMeta('first_contact_alert_delayed', e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs"
              style={{ background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border)', color: 'var(--ao-text)' }}>
              <option value="true">Sim — só alerta após 10min (reduz ruído)</option>
              <option value="false">Não — notifica grupo na classificação (60s)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Níveis de escalation */}
      <div className="rounded-lg overflow-hidden" style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
        <div className="px-4 py-2 text-sm font-semibold flex items-center gap-2 border-b" style={{ borderColor: 'var(--ao-border)' }}>
          <Bell size={14} /> Níveis de escalation ({cfg.levels.length})
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--ao-border)' }}>
          {cfg.levels.map(l => (
            <div key={l.level} className="p-4 grid grid-cols-1 lg:grid-cols-[auto_100px_1fr_auto] gap-3 items-start"
              style={{ borderBottom: '1px solid var(--ao-border)' }}>
              {/* Emoji + Level */}
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 20 }}>{l.emoji}</span>
                <div>
                  <div className="text-xs opacity-60">Nível {l.level}</div>
                  <input value={l.label} onChange={e => updateLevel(l.level, { label: e.target.value })}
                    className="text-sm font-semibold bg-transparent border-none outline-none"
                    style={{ color: SEV_COLOR[l.severity] || 'var(--ao-text)', width: '220px' }} />
                </div>
              </div>

              {/* Minutos */}
              <div>
                <label className="text-[10px] opacity-60">Disparar após</label>
                <div className="flex items-center gap-1">
                  <input type="number" value={l.minutes}
                    onChange={e => updateLevel(l.level, { minutes: parseInt(e.target.value) || 0 })}
                    className="w-20 px-2 py-1 rounded text-xs"
                    style={{ background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border)', color: 'var(--ao-text)' }} />
                  <span className="text-xs opacity-60">min ({fmtDuration(l.minutes)})</span>
                </div>
              </div>

              {/* Mensagem ao cliente */}
              <div>
                <label className="text-[10px] opacity-60">Mensagem ao cliente (vazio = só equipe)</label>
                <textarea rows={3} value={l.client_message || ''}
                  onChange={e => updateLevel(l.level, { client_message: e.target.value || null })}
                  placeholder="Deixe vazio para não enviar ao cliente neste nível..."
                  className="w-full px-2 py-1.5 rounded text-xs resize-vertical font-mono"
                  style={{ background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border)', color: 'var(--ao-text)' }} />
                <div className="text-[10px] opacity-50 mt-1">{'{firstName}'} substituído pelo primeiro nome do cliente</div>
              </div>

              {/* Toggles */}
              <div className="flex flex-col gap-1 text-xs whitespace-nowrap">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!l.active}
                    onChange={e => updateLevel(l.level, { active: e.target.checked })} />
                  <span>Ativo</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!l.send_to_team}
                    onChange={e => updateLevel(l.level, { send_to_team: e.target.checked })} />
                  <span>Avisar equipe</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer" title="Envia WhatsApp equipe mesmo fora do horário comercial">
                  <input type="checkbox" checked={!!l.team_even_off_hours}
                    onChange={e => updateLevel(l.level, { team_even_off_hours: e.target.checked })} />
                  <span>Fora de horário</span>
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Auto-resolve candidates */}
      <div className="rounded-lg" style={{ background: 'var(--ao-surface)', border: '1px solid var(--ao-border)' }}>
        <div className="px-4 py-2 text-sm font-semibold flex items-center justify-between border-b" style={{ borderColor: 'var(--ao-border)' }}>
          <span className="flex items-center gap-2"><Clock size={14} /> Candidatos a auto-resolve ({candidates.length})</span>
          {candidates.length > 0 && (
            <button onClick={runAutoResolve} className="px-3 py-1 rounded text-xs"
              style={{ background: 'rgb(239 68 68)', color: 'white' }}>
              Resolver agora
            </button>
          )}
        </div>
        {candidates.length === 0 ? (
          <div className="p-4 text-xs opacity-60 text-center">Nenhuma conversa elegível (precisa nível ≥ 6 + {cfg.meta.auto_resolve_hours}h sem msg).</div>
        ) : (
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--ao-bg)' }}>
              <tr>
                <th className="text-left p-2">Cliente</th>
                <th className="text-left p-2">Telefone</th>
                <th className="text-left p-2">Nível</th>
                <th className="text-left p-2">Última msg</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map(c => (
                <tr key={c.phone} className="border-t" style={{ borderColor: 'var(--ao-border)' }}>
                  <td className="p-2">{c.client_name}</td>
                  <td className="p-2 opacity-70">{c.display_phone || c.phone}</td>
                  <td className="p-2">{c.escalation_level}</td>
                  <td className="p-2 opacity-70">{new Date(c.last_message_at).toLocaleString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function MetaField({ icon: Icon, label, hint, value, onChange, type = 'text' }) {
  return (
    <div>
      <label className="text-xs opacity-70 flex items-center gap-1 mb-1">
        {Icon && <Icon size={12} />} {label}
      </label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-2 py-1.5 rounded text-xs"
        style={{ background: 'var(--ao-input-bg)', border: '1px solid var(--ao-border)', color: 'var(--ao-text)' }} />
      {hint && <div className="text-[10px] opacity-50 mt-0.5">{hint}</div>}
    </div>
  )
}
