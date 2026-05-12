import { useState, useEffect } from 'react'

/**
 * Hook que pega o usuário logado via cookie compartilhado com Gesthub.
 * Retorna { user, loading, isAdmin, can(moduleId) }.
 *
 * Se não autenticado, redireciona pra Gesthub (após delay pra evitar loop).
 */
export function useUser({ redirectIfNotAuth = true } = {}) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/me', { credentials: 'include' })
      .then(r => {
        if (cancelled) return
        if (r.ok) {
          return r.json().then(d => setUser(d.data || null))
        }
        if (r.status === 401 && redirectIfNotAuth) {
          // Redireciona pro Gesthub com return URL
          const ret = encodeURIComponent(window.location.href)
          setTimeout(() => {
            window.location.href = `http://31.97.175.200/?next=${ret}`
          }, 800)
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [redirectIfNotAuth])

  const isAdmin = user?.role === 'admin'
  const visibleSet = new Set(Array.isArray(user?.modulosVisiveis) ? user.modulosVisiveis : [])
  const can = (moduleId) => {
    if (!user) return false
    if (isAdmin) return true
    return visibleSet.has(moduleId)
  }

  return { user, loading, isAdmin, can }
}
