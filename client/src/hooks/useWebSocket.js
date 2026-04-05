import { useState, useEffect, useRef, useCallback } from 'react'

export function useWebSocket() {
  const [connected, setConnected] = useState(false)
  const [lastMessage, setLastMessage] = useState(null)
  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      // Reconnect after 3s
      reconnectTimer.current = setTimeout(connect, 3000)
    }
    ws.onerror = () => ws.close()
    ws.onmessage = (event) => {
      try {
        setLastMessage(JSON.parse(event.data))
      } catch {
        // ignore non-JSON messages
      }
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { connected, lastMessage, send }
}
