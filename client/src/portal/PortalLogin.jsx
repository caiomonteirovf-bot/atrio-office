import { useState } from 'react'

export default function PortalLogin({ onLogin }) {
  const [cnpj, setCnpj] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  function formatCnpj(value) {
    const digits = value.replace(/\D/g, '').slice(0, 14)
    if (digits.length <= 11) {
      return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, (_, a, b, c, d) =>
        d ? `${a}.${b}.${c}-${d}` : c ? `${a}.${b}.${c}` : b ? `${a}.${b}` : a
      )
    }
    return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, (_, a, b, c, d, e) =>
      e ? `${a}.${b}.${c}/${d}-${e}` : d ? `${a}.${b}.${c}/${d}` : c ? `${a}.${b}.${c}` : b ? `${a}.${b}` : a
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const digits = cnpj.replace(/\D/g, '')
    if (digits.length < 11) {
      setError('Digite um CNPJ ou CPF válido')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/portal/login/${digits}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Cliente não encontrado')
      onLogin(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0f172a] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center mx-auto mb-4 shadow-xl shadow-indigo-500/20">
            <span className="text-white text-xl font-black">A</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100">
            Átrio <span className="text-indigo-400">Contabilidade</span>
          </h1>
          <p className="text-slate-500 text-sm mt-2">Portal do Cliente</p>
        </div>

        {/* Login form */}
        <form onSubmit={handleSubmit} className="bg-slate-800/40 border border-slate-700/30 rounded-2xl p-6 space-y-4">
          <div>
            <label className="block text-[12px] text-slate-400 font-medium mb-2">
              Acesse com seu CNPJ ou CPF
            </label>
            <input
              type="text"
              value={cnpj}
              onChange={(e) => setCnpj(formatCnpj(e.target.value))}
              placeholder="00.000.000/0000-00"
              className="w-full bg-slate-900/50 border border-slate-700/50 rounded-xl px-4 py-3 text-slate-200 text-[14px] placeholder:text-slate-600 outline-none focus:border-indigo-500/50 transition-colors"
              autoFocus
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <p className="text-red-400 text-[12px]">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 text-white font-semibold py-3 rounded-xl transition-colors text-[13px]"
          >
            {loading ? 'Consultando...' : 'Acessar Portal'}
          </button>
        </form>

        <p className="text-center text-slate-600 text-[10px] mt-6">
          Átrio Contabilidade — Escritório contábil digital
        </p>
      </div>
    </div>
  )
}
