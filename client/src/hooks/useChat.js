import { useState, useCallback, useRef } from 'react'
import { api } from '../lib/api'

export function useChat(agentId) {
  const [messages, setMessages] = useState([])
  const [conversationId, setConversationId] = useState(null)
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || loadingRef.current) return

    // Add user message optimistically
    setMessages(prev => [...prev, { role: 'user', content: text, created_at: new Date().toISOString() }])
    setLoading(true)
    loadingRef.current = true

    try {
      const data = await api.sendMessage(agentId, text, conversationId)
      setConversationId(data.conversationId)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.response,
        created_at: new Date().toISOString(),
        agent: data.agent,
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'system',
        content: `Erro: ${err.message}`,
        created_at: new Date().toISOString(),
      }])
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [agentId, conversationId])

  const clearChat = useCallback(() => {
    setMessages([])
    setConversationId(null)
  }, [])

  return { messages, loading, sendMessage, clearChat, conversationId }
}
