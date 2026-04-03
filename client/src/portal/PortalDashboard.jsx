import { useState, useEffect } from 'react'

const STATUS_COLORS = {
  'EM ANDAMENTO': 'bg-indigo-500/20 text-indigo-300',
  'CONCLUIDO': 'bg-emerald-500/20 text-emerald-300',
  'AGUARDANDO DOCUMENTOS': 'bg-amber-500/20 text-amber-300',
  'PROTOCOLO ENVIADO': 'bg-blue-500/20 text-blue-300',
  'AGUARDANDO ORGAO': 'bg-purple-500/20 text-purple-300',
  'EM EXIGENCIA': 'bg-red-500/20 text-red-300',
  'CANCELADO': 'bg-slate-500/20 text-slate-400',
}

const TASK_STATUS = {
  pending: { label: 'Pendente', color: 'text-slate-400' },
  in_progress: { label: 'Em andamento', color: 'text-indigo-400' },
  done: { label: 'Concluída', color: 'text-emerald-400' },
  blocked: { label: 'Bloqueada', color: 'text-red-400' },
}

export default function PortalDashboard({ clientBasic, onLogout }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeSection, setActiveSection] = useState('overview')

  useEffect(() => {
    fetch(`/api/portal/client/${clientBasic.id}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [clientBasic.id])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0f172a] flex items-center justify-center">
        <p className="text-slate-500 text-sm">Carregando dados...</p>
      </div>
    )
  }

  const profile = data?.profile || clientBasic

  return (
    <div className="min-h-screen bg-[#0f172a]">
      {/* Header */}
      <header className="bg-[#1e293b]/80 border-b border-slate-700/40">
        <div className="max-w-[1200px] mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
              <span className="text-white text-[10px] font-black">A</span>
            </div>
            <div>
              <span className="text-slate-100 text-[13px] font-semibold">Átrio</span>
              <span className="text-indigo-400 text-[13px] font-semibold ml-1">Portal</span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-slate-500 text-[11px]">{profile.document}</span>
            <button onClick={onLogout} className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors">
              Sair
            </button>
          </div>
        </div>

        {/* Nav */}
        <div className="max-w-[1200px] mx-auto px-6 flex gap-1">
          {[
            { id: 'overview', label: 'Visão Geral' },
            { id: 'legal', label: 'Processos' },
            { id: 'tasks', label: 'Atividades' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveSection(tab.id)}
              className={`px-4 py-2.5 text-[12px] font-medium transition-all relative
                ${activeSection === tab.id ? 'text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {tab.label}
              {activeSection === tab.id && (
                <span className="absolute bottom-0 left-3 right-3 h-[2px] rounded-t-full bg-indigo-500" />
              )}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <main className="max-w-[1200px] mx-auto px-6 py-6">
        {activeSection === 'overview' && (
          <div className="space-y-6">
            {/* Welcome */}
            <div className="bg-gradient-to-r from-indigo-600/10 to-violet-600/10 border border-indigo-500/20 rounded-2xl p-6">
              <h1 className="text-xl font-bold text-slate-100">
                Olá, {profile.tradeName || profile.name?.split(' ').slice(0, 2).join(' ')}
              </h1>
              <p className="text-slate-400 text-[13px] mt-1">
                Bem-vindo ao portal do cliente Átrio Contabilidade
              </p>
            </div>

            {/* Info cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Regime tributário</p>
                <p className="text-lg font-semibold text-slate-200">{profile.regime || '—'}</p>
              </div>
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Responsável</p>
                <p className="text-lg font-semibold text-slate-200">{profile.analyst || '—'}</p>
              </div>
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
                <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Status</p>
                <p className="text-lg font-semibold text-emerald-400">{profile.status || '—'}</p>
              </div>
            </div>

            {/* Details */}
            <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-5">
              <h2 className="text-[13px] font-semibold text-slate-300 mb-4">Dados cadastrais</h2>
              <div className="grid grid-cols-2 gap-y-3 gap-x-8 text-[12px]">
                <div>
                  <span className="text-slate-500">Razão Social</span>
                  <p className="text-slate-200 mt-0.5">{profile.name}</p>
                </div>
                <div>
                  <span className="text-slate-500">CNPJ/CPF</span>
                  <p className="text-slate-200 mt-0.5">{profile.document}</p>
                </div>
                <div>
                  <span className="text-slate-500">Tipo</span>
                  <p className="text-slate-200 mt-0.5">{profile.type || '—'}</p>
                </div>
                <div>
                  <span className="text-slate-500">Cidade/UF</span>
                  <p className="text-slate-200 mt-0.5">{profile.city || '—'}/{profile.state || '—'}</p>
                </div>
                {profile.monthlyFee > 0 && (
                  <div>
                    <span className="text-slate-500">Honorário mensal</span>
                    <p className="text-slate-200 mt-0.5">
                      {profile.monthlyFee?.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                    </p>
                  </div>
                )}
                {profile.fatorR && profile.fatorR !== '--' && (
                  <div>
                    <span className="text-slate-500">Fator R</span>
                    <p className="text-slate-200 mt-0.5">{profile.fatorR}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeSection === 'legal' && (
          <div className="space-y-4">
            <h2 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">
              Processos de legalização
            </h2>
            {(!data?.legalizations || data.legalizations.length === 0) ? (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-8 text-center">
                <p className="text-slate-500 text-[12px]">Nenhum processo em andamento</p>
              </div>
            ) : (
              <div className="space-y-3">
                {data.legalizations.map(leg => {
                  const statusClass = STATUS_COLORS[leg.status] || 'bg-slate-500/20 text-slate-400'
                  return (
                    <div key={leg.id} className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-[13px] font-medium text-slate-200">{leg.processType || 'Processo'}</p>
                          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-500">
                            {leg.organ && <span>{leg.organ}</span>}
                            {leg.protocol && <span>Protocolo: {leg.protocol}</span>}
                            {leg.openDate && <span>Aberto: {new Date(leg.openDate).toLocaleDateString('pt-BR')}</span>}
                          </div>
                        </div>
                        <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${statusClass}`}>
                          {leg.status}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {activeSection === 'tasks' && (
          <div className="space-y-4">
            <h2 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wider">
              Atividades recentes
            </h2>
            {(!data?.tasks || data.tasks.length === 0) ? (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl p-8 text-center">
                <p className="text-slate-500 text-[12px]">Nenhuma atividade registrada</p>
              </div>
            ) : (
              <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl overflow-hidden">
                <div className="divide-y divide-slate-700/30">
                  {data.tasks.map((task, i) => {
                    const ts = TASK_STATUS[task.status] || TASK_STATUS.pending
                    return (
                      <div key={i} className="px-4 py-3 flex items-center gap-3">
                        <span className={`text-[11px] font-medium ${ts.color}`}>{ts.label}</span>
                        <p className="text-[12px] text-slate-300 flex-1 truncate">{task.title}</p>
                        {task.assigned && <span className="text-[10px] text-slate-500">{task.assigned}</span>}
                        <span className="text-[10px] text-slate-600 tabular-nums">
                          {new Date(task.date).toLocaleDateString('pt-BR')}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
