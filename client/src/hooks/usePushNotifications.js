import { useCallback, useEffect, useState } from 'react'

/**
 * Hook para gerenciar Push Notifications.
 *
 * Estados:
 *   - supported: browser tem suporte
 *   - permission: 'default' | 'granted' | 'denied'
 *   - subscribed: se ja tem subscription ativa
 *
 * Ações:
 *   - enable(): pede permissão + registra no backend
 *   - disable(): remove subscription local e do backend
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export default function usePushNotifications(userId = 'caio') {
  const supported = typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  const [permission, setPermission] = useState(supported ? Notification.permission : 'denied')
  const [subscribed, setSubscribed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!supported) return
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      setSubscribed(!!sub)
      setPermission(Notification.permission)
    } catch (e) { /* ignore */ }
  }, [supported])

  useEffect(() => { refresh() }, [refresh])

  const enable = useCallback(async () => {
    if (!supported) { setError('Navegador sem suporte a push'); return }
    setLoading(true)
    setError(null)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') throw new Error('Permissão negada')

      const keyRes = await fetch('/api/push/public-key')
      if (!keyRes.ok) throw new Error('VAPID key indisponivel')
      const { publicKey } = await keyRes.json()

      const reg = await navigator.serviceWorker.ready
      // Se ja tem sub, reaproveita
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        })
      }

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          subscription: sub.toJSON(),
          userAgent: navigator.userAgent,
        }),
      })
      if (!res.ok) throw new Error('Falha ao registrar no servidor')
      setSubscribed(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [supported, userId])

  const disable = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {})
        await sub.unsubscribe().catch(() => {})
      }
      setSubscribed(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const test = useCallback(async () => {
    await fetch('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        title: 'Teste de notificação',
        body: 'Se você está vendo isso, push está funcionando! 🎉',
        url: '/',
      }),
    })
  }, [userId])

  return { supported, permission, subscribed, loading, error, enable, disable, test, refresh }
}
