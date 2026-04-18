import ClientDocsTab from './ClientDocsTab'
import { useEffect, useState } from 'react'

const fmtMoney = (v) => v == null || v === '' ? '—' : new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(Number(v))
const fmtInt   = (v) => v == null || v === '' ? '—' : new Intl.NumberFormat('pt-BR').format(Number(v))
const fmtDate  = (v) => v ? new Date(v).toLocaleDateString('pt-BR') : '—'
const fmtPct   = (v) => v == null || v === '' ? '—' : `${Number(v).toFixed(2).replace('.',',')}%`
const fmtBool  = (v) => v === true ? 'Sim' : v === false ? 'Não' : '—'
const fmtCnpj  = (c) => {
  if (!c) return '—'
  const d = String(c).replace(/\D/g,'').padStart(14,'0')
  return d.length===14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c
}
const fmtCep = (c) => {
  if (!c) return '—'
  const d = String(c).replace(/\D/g,'')
  return d.length === 8 ? d.replace(/^(\d{5})(\d{3})$/, '$1-$2') : c
}
const fmtPhone = (p) => {
  if (!p) return '—'
  const d = String(p).replace(/\D/g,'')
  if (d.length === 13) return `+${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`
  return p
}

export default function DatalakeViewer() {
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [facets, setFacets] = useState({ analyst:[], regime:[], status:[] })
  const [q, setQ] = useState('')
  const [analyst, setAnalyst] = useState('')
  const [regime, setRegime] = useState('')
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [tab, setTab] = useState('identidade')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/datalake/summary').then(r => r.json()).then(setSummary).catch(()=>{})
    fetch('/api/datalake/facets').then(r => r.json()).then(setFacets).catch(()=>{})
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true)
      const qs = new URLSearchParams()
      if (q) qs.set('q', q)
      if (analyst) qs.set('analyst', analyst)
      if (regime)  qs.set('regime', regime)
      if (status)  qs.set('status', status)
      fetch('/api/datalake/clientes?'+qs).then(r=>r.json()).then(d => { setRows(d.rows||[]); setLoading(false) })
    }, 250)
    return () => clearTimeout(t)
  }, [q, analyst, regime, status])

  useEffect(() => {
    if (!selected) { setDetail(null); return }
    setDetail(null)
    setTab('identidade')
    fetch(`/api/datalake/cliente/${selected}`).then(r=>r.json()).then(setDetail)
  }, [selected])

  const c = detail?.cliente

  return (
    <div className="h-full flex flex-col" style={{ color:'var(--ao-text)' }}>
      {/* Header stats */}
      <div className="flex items-center gap-6 px-6 py-4" style={{ borderBottom:'1px solid var(--ao-border)' }}>
        <div>
          <div className="text-[11px] uppercase tracking-wider" style={{ color:'var(--ao-text-dim)' }}>Datalake</div>
          <div className="text-[20px] font-semibold" style={{ fontFamily:'Outfit' }}>Clientes 360°</div>
        </div>
        {summary && (
          <div className="flex gap-5 ml-auto">
            <Stat label="Total" value={summary.total} />
            <Stat label="Ativos" value={summary.ativos} ok />
            <Stat label="c/ Luna" value={summary.com_luna} />
            <Stat label="s/ Luna" value={summary.sem_luna} warn />
            <Stat label="Receita/mês" value={fmtMoney(summary.receita_mensal)} />
          </div>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Lista */}
        <div className="flex-1 flex flex-col min-w-0" style={{ borderRight: selected ? '1px solid var(--ao-border)' : 'none' }}>
          <div className="flex gap-2 px-6 py-3" style={{ borderBottom:'1px solid var(--ao-border)', background:'var(--ao-card)' }}>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar por razão social, CNPJ ou sócio..."
              className="flex-1 h-9 px-3 rounded-md text-[13px] outline-none"
              style={{ background:'var(--ao-input-bg)', border:'1px solid var(--ao-border)', color:'var(--ao-text)' }} />
            <FilterSelect value={analyst} onChange={setAnalyst} opts={facets.analyst} placeholder="Analista" />
            <FilterSelect value={regime}  onChange={setRegime}  opts={facets.regime}  placeholder="Regime" />
            <FilterSelect value={status}  onChange={setStatus}  opts={facets.status}  placeholder="Status" />
            {(q||analyst||regime||status) && (
              <button onClick={()=>{ setQ(''); setAnalyst(''); setRegime(''); setStatus('') }}
                className="h-9 px-3 rounded-md text-[12px]" style={{ border:'1px solid var(--ao-border)', color:'var(--ao-text-dim)' }}>Limpar</button>
            )}
          </div>

          <div className="flex-1 overflow-auto">
            <table className="w-full text-[13px]">
              <thead style={{ position:'sticky', top:0, background:'var(--ao-card)', zIndex:2 }}>
                <tr style={{ color:'var(--ao-text-dim)', fontSize:'11px', textTransform:'uppercase', letterSpacing:'0.04em' }}>
                  <th className="text-left px-4 py-2.5 font-medium">Cliente</th>
                  <th className="text-left px-4 py-2.5 font-medium">CNPJ</th>
                  <th className="text-left px-4 py-2.5 font-medium">Regime</th>
                  <th className="text-left px-4 py-2.5 font-medium">Analista</th>
                  <th className="text-left px-4 py-2.5 font-medium">Sócio resp.</th>
                  <th className="text-center px-4 py-2.5 font-medium" title="Contatos / Sócios / NFS-e 12m">Estrutura</th>
                  <th className="text-right px-4 py-2.5 font-medium">Mensalidade</th>
                  <th className="text-center px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={8} className="text-center py-8" style={{ color:'var(--ao-text-dim)' }}>Carregando...</td></tr>}
                {!loading && rows.length===0 && <tr><td colSpan={8} className="text-center py-8" style={{ color:'var(--ao-text-dim)' }}>Nenhum cliente encontrado</td></tr>}
                {rows.map(r => (
                  <tr key={r.gesthub_id} onClick={()=>setSelected(r.gesthub_id)}
                    className="cursor-pointer transition-colors"
                    style={{
                      background: selected===r.gesthub_id ? 'var(--ao-input-bg)' : 'transparent',
                      borderBottom:'1px solid var(--ao-border)',
                    }}
                    onMouseEnter={e=>{ if(selected!==r.gesthub_id) e.currentTarget.style.background='var(--ao-card)' }}
                    onMouseLeave={e=>{ if(selected!==r.gesthub_id) e.currentTarget.style.background='transparent' }}>
                    <td className="px-4 py-2.5">
                      <div style={{ fontWeight:600 }}>{r.nome_fantasia || r.razao_social}</div>
                      {r.nome_fantasia && r.razao_social && r.nome_fantasia !== r.razao_social &&
                        <div className="text-[11px]" style={{ color:'var(--ao-text-dim)' }}>{r.razao_social}</div>}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums" style={{ color:'var(--ao-text-secondary)' }}>{fmtCnpj(r.cnpj)}</td>
                    <td className="px-4 py-2.5">
                      <div>{r.regime || '—'}</div>
                      {r.optante_simples && <div className="text-[10px] uppercase tracking-wide" style={{ color:'#10b981' }}>Simples</div>}
                      {r.fator_r != null && <div className="text-[10px]" style={{ color:'var(--ao-text-dim)' }}>Fator R</div>}
                    </td>
                    <td className="px-4 py-2.5">{r.analyst || '—'}</td>
                    <td className="px-4 py-2.5">{r.socio_responsavel || '—'}</td>
                    <td className="px-4 py-2.5 text-center text-[11.5px] tabular-nums" style={{ color:'var(--ao-text-secondary)' }}>
                      <span title="Contatos">👤{r.qtd_contatos || 0}</span>
                      <span className="mx-1.5" style={{ color:'var(--ao-border)' }}>·</span>
                      <span title="Sócios">⚖{r.qtd_socios || 0}</span>
                      <span className="mx-1.5" style={{ color:'var(--ao-border)' }}>·</span>
                      <span title="NFS-e total">📄{r.nfse_emitidas || 0}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmtMoney(r.mensalidade)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="inline-block px-2 py-0.5 rounded text-[10.5px] uppercase tracking-wide"
                        style={{
                          background: r.status_gesthub==='ATIVO' ? '#10b98122' : '#ef444422',
                          color: r.status_gesthub==='ATIVO' ? '#10b981' : '#ef4444',
                          fontWeight:600,
                        }}>{r.status_gesthub || '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detalhe */}
        {selected && (
          <div className="w-[460px] flex flex-col" style={{ background:'var(--ao-card)' }}>
            {!detail && <div className="p-6 text-[13px]" style={{ color:'var(--ao-text-dim)' }}>Carregando...</div>}
            {detail && c && (
              <>
                <div className="px-5 py-4" style={{ borderBottom:'1px solid var(--ao-border)' }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[16px] font-semibold truncate" style={{ fontFamily:'Outfit' }}>{c.nome_fantasia || c.razao_social}</div>
                      {c.nome_fantasia && c.razao_social && <div className="text-[12px] truncate" style={{ color:'var(--ao-text-dim)' }}>{c.razao_social}</div>}
                      <div className="text-[11.5px] mt-1 tabular-nums" style={{ color:'var(--ao-text-secondary)' }}>
                        {fmtCnpj(c.cnpj)} · <span style={{ color:c.status_gesthub==='ATIVO'?'#10b981':'#ef4444' }}>{c.status_gesthub}</span>
                      </div>
                    </div>
                    <button onClick={()=>setSelected(null)} className="text-[18px] px-2" style={{ color:'var(--ao-text-dim)' }}>✕</button>
                  </div>

                  {/* Tabs */}
                  <div className="flex gap-1 mt-3 -mb-px">
                    {[
                      ['identidade', 'Identidade'],
                      ['tributario', 'Tributário'],
                      ['contatos',   `Contatos (${(detail.contatos?.length||0)+(detail.socios?.length||0)})`],
                      ['endereco',   'Endereço'],
                      ['luna',       'Luna'],
                      ['docs',       'Documentos'],
                    ].map(([id, label]) => (
                      <button key={id} onClick={()=>setTab(id)}
                        className="px-2.5 py-1.5 text-[11.5px] rounded-t transition-colors"
                        style={{
                          borderBottom: tab===id ? '2px solid var(--ao-text)' : '2px solid transparent',
                          color: tab===id ? 'var(--ao-text)' : 'var(--ao-text-dim)',
                          fontWeight: tab===id ? 600 : 500,
                        }}>{label}</button>
                    ))}
                  </div>
                </div>

                <div className="flex-1 overflow-auto p-5">
                  {tab === 'identidade' && (
                    <div className="space-y-5">
                      <Section title="Contrato">
                        <KV k="Mensalidade" v={fmtMoney(c.mensalidade)} />
                        <KV k="Cliente desde" v={fmtDate(c.cliente_desde)} />
                        <KV k="Competência início" v={c.competencia_inicio} />
                        <KV k="Analista interno" v={c.analyst} />
                        <KV k="Sócio responsável" v={c.socio_responsavel} />
                        <KV k="Célula" v={c.celula} />
                        <KV k="Tipo contrato" v={c.tipo_ctr} />
                        <KV k="Prazo entrega" v={c.prazo_entrega} />
                        <KV k="Em onboarding" v={fmtBool(c.em_onboarding)} />
                        <KV k="Classificação CS" v={c.classificacao_cs} />
                      </Section>
                      <Section title="Empresa">
                        <KV k="Tipo cliente" v={c.client_type} />
                        <KV k="Grupo" v={c.group_name} />
                        <KV k="Natureza jurídica" v={c.natureza_juridica} />
                        <KV k="Porte" v={c.porte} />
                        <KV k="Capital social" v={fmtMoney(c.capital_social)} />
                        <KV k="Data abertura" v={fmtDate(c.data_abertura)} />
                        <KV k="Situação cadastral" v={c.situacao_cadastral} />
                        <KV k="Colaboradores" v={fmtInt(c.headcount)} />
                      </Section>
                      <Section title="Última entrega">
                        <KV k="Data" v={fmtDate(c.data_ultima_entrega)} />
                        <KV k="Tipo" v={c.tipo_ultima_entrega} />
                      </Section>
                      {(c.notes || c.internal_notes) && (
                        <Section title="Observações">
                          {c.notes && <div className="text-[12px] mb-2" style={{ color:'var(--ao-text-secondary)' }}>{c.notes}</div>}
                          {c.internal_notes && <div className="text-[12px] px-2 py-1.5 rounded" style={{ background:'var(--ao-input-bg)', color:'var(--ao-text-secondary)' }}>Interna: {c.internal_notes}</div>}
                        </Section>
                      )}
                    </div>
                  )}

                  {tab === 'tributario' && (
                    <div className="space-y-5">
                      <Section title="Regime">
                        <KV k="Tax regime" v={c.regime} />
                        <KV k="Optante Simples" v={fmtBool(c.optante_simples)} />
                        <KV k="Optante MEI" v={fmtBool(c.optante_mei)} />
                        <KV k="Fator R" v={c.fator_r != null ? String(c.fator_r) : '—'} />
                        <KV k="Regime especial" v={c.regime_especial} />
                        <KV k="Natureza operação" v={c.natureza_operacao} />
                      </Section>
                      <Section title="CNAE">
                        <KV k="CNAE principal" v={c.cnae_principal || c.cnae_raw} />
                        <KV k="Descrição" v={c.cnae_descricao} />
                      </Section>
                      <Section title="NFS-e / Municipal">
                        <KV k="Inscrição Municipal" v={c.inscricao_municipal} />
                        <KV k="Inscrição Estadual" v={c.inscricao_estadual} />
                        <KV k="Código serviço" v={c.codigo_servico} />
                        <KV k="Item lista serviço" v={c.item_lista_servico} />
                        <KV k="Cód. tributação municipal" v={c.codigo_tributacao_municipal} />
                        <KV k="Alíquota ISS" v={fmtPct(c.aliquota_iss)} />
                      </Section>
                      <Section title="NFS-e emitidas">
                        <KV k="Total histórico" v={fmtInt(c.nfse_emitidas)} />
                        <KV k="Última emissão" v={fmtDate(c.nfse_ultima_emissao)} />
                        <KV k="Faturado 12m" v={fmtMoney(c.nfse_valor_12m)} />
                      </Section>
                    </div>
                  )}

                  {tab === 'contatos' && (
                    <div className="space-y-5">
                      <Section title="Telefone/Email principal">
                        <KV k="Telefone" v={fmtPhone(c.telefone)} />
                        <KV k="Email" v={c.email} />
                      </Section>
                      {detail.socios?.length > 0 && (
                        <Section title={`Sócios (${detail.socios.length})`}>
                          {detail.socios.map((s,i) => (
                            <div key={i} className="py-2 text-[12.5px]" style={{ borderTop:'1px dashed var(--ao-border)' }}>
                              <div style={{ fontWeight:600 }}>{s.nome} {s.qualificacao && <span className="text-[11px] font-normal" style={{ color:'var(--ao-text-dim)' }}>· {s.qualificacao}</span>}</div>
                              {s.cpf_cnpj && <div className="tabular-nums" style={{ color:'var(--ao-text-secondary)' }}>{s.cpf_cnpj}</div>}
                              {s.telefone && <div className="tabular-nums" style={{ color:'var(--ao-text-secondary)' }}>{fmtPhone(s.telefone)}</div>}
                              {s.email && <div style={{ color:'var(--ao-text-secondary)' }}>{s.email}</div>}
                              {s.participacao != null && <div className="text-[11px]" style={{ color:'var(--ao-text-dim)' }}>Participação: {s.participacao}%</div>}
                            </div>
                          ))}
                        </Section>
                      )}
                      {detail.contatos?.length > 0 && (
                        <Section title={`Contatos extras (${detail.contatos.length})`}>
                          {detail.contatos.map(ct => (
                            <div key={ct.id} className="py-2 text-[12.5px]" style={{ borderTop:'1px dashed var(--ao-border)' }}>
                              <div style={{ fontWeight:600 }}>{ct.nome} {ct.funcao && <span className="text-[11px] font-normal" style={{ color:'var(--ao-text-dim)' }}>· {ct.funcao}</span>}</div>
                              {ct.telefone && <div className="tabular-nums" style={{ color:'var(--ao-text-secondary)' }}>{fmtPhone(ct.telefone)}</div>}
                              {ct.email && <div style={{ color:'var(--ao-text-secondary)' }}>{ct.email}</div>}
                              {ct.cpf && <div className="text-[11px] tabular-nums" style={{ color:'var(--ao-text-dim)' }}>CPF: {ct.cpf}</div>}
                            </div>
                          ))}
                        </Section>
                      )}
                      {(!detail.contatos?.length && !detail.socios?.length) && (
                        <div className="text-[12px]" style={{ color:'var(--ao-text-dim)' }}>Sem contatos cadastrados.</div>
                      )}
                    </div>
                  )}

                  {tab === 'endereco' && (
                    <Section title="Endereço">
                      <KV k="Logradouro" v={[c.logradouro, c.numero_endereco].filter(Boolean).join(', ')} />
                      <KV k="Complemento" v={c.complemento} />
                      <KV k="Bairro" v={c.bairro} />
                      <KV k="Cidade/UF" v={[c.city, c.state].filter(Boolean).join(' / ')} />
                      <KV k="CEP" v={fmtCep(c.cep)} />
                      <KV k="Cód. município IBGE" v={c.codigo_municipio_ibge} />
                    </Section>
                  )}

                  {tab === 'docs' && (
                    <div className="space-y-3">
                      <Section title="Documentos ingeridos">
                        <ClientDocsTab gesthub_id={c.gesthub_id} />
                      </Section>
                    </div>
                  )}
                  {tab === 'luna' && (
                    <div className="space-y-5">
                      {!c.luna_client_id ? (
                        <div className="text-[11.5px] px-3 py-2 rounded" style={{ background:'#f59e0b18', color:'#f59e0b', border:'1px solid #f59e0b44' }}>
                          ⚠ Este cliente não está vinculado à Luna ainda. Nenhum histórico de conversa.
                        </div>
                      ) : (
                        <>
                          <Section title="Resumo">
                            <KV k="Conversas" v={fmtInt(c.conversas_whatsapp)} />
                            <KV k="Memórias ativas" v={fmtInt(c.memorias_ativas)} />
                            <KV k="Última conversa" v={fmtDate(c.ultima_conversa)} />
                          </Section>
                          {detail.conversas?.length > 0 && (
                            <Section title={`Conversas (${detail.conversas.length})`}>
                              {detail.conversas.map(cv => (
                                <div key={cv.id} className="py-2 text-[12px] flex justify-between gap-2" style={{ borderTop:'1px dashed var(--ao-border)' }}>
                                  <span className="tabular-nums" style={{ color:'var(--ao-text-secondary)' }}>{fmtPhone(cv.phone)}</span>
                                  <span style={{ color:'var(--ao-text-dim)' }}>{cv.mensagens_count || 0} msgs · {cv.attendance_status}</span>
                                </div>
                              ))}
                            </Section>
                          )}
                          {detail.memorias?.length > 0 && (
                            <Section title={`Memórias (${detail.memorias.length})`}>
                              {detail.memorias.map(m => (
                                <div key={m.id} className="py-2 text-[12px]" style={{ borderTop:'1px dashed var(--ao-border)' }}>
                                  <div className="flex justify-between">
                                    <span style={{ fontWeight:600 }}>{m.titulo || m.tipo}</span>
                                    <span style={{ color:'var(--ao-text-dim)' }}>P{m.prioridade}</span>
                                  </div>
                                  {m.conteudo && <div style={{ color:'var(--ao-text-secondary)' }}>{m.conteudo}</div>}
                                </div>
                              ))}
                            </Section>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, warn, ok }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider" style={{ color:'var(--ao-text-dim)' }}>{label}</div>
      <div className="text-[16px] font-semibold tabular-nums" style={{ color: warn ? '#f59e0b' : ok ? '#10b981' : 'var(--ao-text)' }}>{value}</div>
    </div>
  )
}

function FilterSelect({ value, onChange, opts, placeholder }) {
  return (
    <select value={value} onChange={e=>onChange(e.target.value)}
      className="h-9 px-2 rounded-md text-[12.5px] outline-none cursor-pointer"
      style={{ background:'var(--ao-input-bg)', border:'1px solid var(--ao-border)', color: value ? 'var(--ao-text)' : 'var(--ao-text-dim)' }}>
      <option value="">{placeholder}</option>
      {opts.map(o => <option key={o.valor} value={o.valor}>{o.valor} ({o.n})</option>)}
    </select>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider mb-2" style={{ color:'var(--ao-text-dim)', letterSpacing:'0.08em' }}>{title}</div>
      <div>{children}</div>
    </div>
  )
}

function KV({ k, v }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-[12.5px]">
      <span style={{ color:'var(--ao-text-dim)' }}>{k}</span>
      <span className="text-right" style={{ color:'var(--ao-text)' }}>{v || v === 0 ? v : '—'}</span>
    </div>
  )
}
