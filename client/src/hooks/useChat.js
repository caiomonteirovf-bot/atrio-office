import { useState, useCallback } from 'react'
import { api } from '../lib/api'

export function useChat(agentId) {
  const [messages, setMessages] = useState([])
  const [conversationId, setConversationId] = useState(null)
  const [loading, setLoading] = useState(false)

  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || loading) return

    // Add user message optimistically
    setMessages(prev => [...prev, { role: 'user', content: text, created_at: new Date().toISOString() }])
    setLoading(true)

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
    }
  }, [agentId, conversationId, loading])

  const clearChat = useCallback(() => {
    setMessages([])
    setConversationId(null)
  }, [])

  return { messages, loading, sendMessage, clearChat, conversationId }
}
