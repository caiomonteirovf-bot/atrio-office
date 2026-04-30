import { useState } from 'react'
import { Trash2, Loader2, Mic, Download, FileText, Image as ImageIcon, Music, Video, Paperclip, Check, CheckCheck } from 'lucide-react'
import { classifySender, deleteMessage } from './atendimento-api'

function fmtSize(n) {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function AttachmentIcon({ type, size = 16 }) {
  if (type === 'image') return <ImageIcon size={size} />
  if (type === 'pdf')   return <FileText size={size} />
  if (type === 'audio') return <Music size={size} />
  if (type === 'video') return <Video size={size} />
  return <Paperclip size={size} />
}

function AttachmentCard({ msgId, attachment, accent = '#10B981' }) {
  const url = `/api/whatsapp/messages/${msgId}/attachment`
  const isImage = attachment.type === 'image'
  const isAudio = attachment.type === 'audio'
  const isVideo = attachment.type === 'video'
  const isExpired = attachment.expired === true

  if (isExpired) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', marginTop: 4, borderRadius: 8,
        background: 'var(--ao-surface)',
        border: '1px dashed var(--ao-border)',
        color: 'var(--ao-text-dim)',
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8,
          background: 'rgba(0,0,0,0.06)', color: 'var(--ao-text-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <AttachmentIcon type={attachment.type} size={17} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {attachment.filename}
          </div>
          <div style={{ fontSize: 10.5, fontStyle: 'italic' }}>
            arquivo expirou após 30 dias
          </div>
        </div>
      </div>
    )
  }

  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 4 }}>
        <img src={url} alt={attachment.filename} style={{
          maxWidth: '100%', maxHeight: 240, borderRadius: 8,
          border: '1px solid rgba(0,0,0,0.1)',
          display: 'block',
        }} />
      </a>
    )
  }
  if (isAudio) {
    return (
      <div style={{ marginTop: 4 }}>
        <audio
          controls
          preload="metadata"
          src={url}
          style={{
            width: '100%', maxWidth: 320, height: 36,
          }}
        />
      </div>
    )
  }
  if (isVideo) {
    return (
      <video
        controls
        preload="metadata"
        src={url}
        style={{
          marginTop: 4, maxWidth: '100%', maxHeight: 280,
          borderRadius: 8, display: 'block',
        }}
      />
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', marginTop: 4, borderRadius: 8,
        background: 'var(--ao-card)',
        border: `1px solid ${accent}44`,
        color: 'var(--ao-text-primary)', textDecoration: 'none',
        transition: 'background 0.12s',
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 8,
        background: `${accent}22`, color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <AttachmentIcon type={attachment.type} size={17} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {attachment.filename}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--ao-text-dim)' }}>
          {attachment.type?.toUpperCase() || 'FILE'} · {fmtSize(attachment.size_bytes)}
        </div>
      </div>
      <Download size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
    </a>
  )
}

/**
 * Bubble de mensagem estilo WhatsApp.
 * Client (esquerda, cinza) vs nosso (direita, verde/bronze).
 * Nossas mensagens (team/luna) tem botao de apagar ao passar o mouse (desktop)
 * ou ao tocar e segurar (mobile — ativa menu via long-press do browser).
 */
export default function MessageBubble({ msg, onDeleted }) {
  const [hovered, setHovered] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const type = classifySender(msg)
  const isClient = type === 'client'
  const isBot = type === 'bot'
  const canDelete = !isClient && !!msg.id  // so nossas mensagens persistidas

  // Mensagem ja apagada?
  const meta = typeof msg.metadata === 'string' ? (() => { try { return JSON.parse(msg.metadata) } catch { return {} } })() : (msg.metadata || {})
  const isDeleted = meta.deleted === true || (msg.body || msg.content) === '[mensagem apagada]'
  const isAudio = meta.is_audio === true
  const audioDuration = meta.duration_sec ? Math.round(meta.duration_sec) : null
  const isGroupMsg = meta.is_group === true
  const author = meta.author
  const attachment = meta.attachment  // {filename, mime_type, size_bytes, type}
  const ackStatus = meta.ack_status  // 'sent' | 'delivered' | 'read' | 'played'

  const bg = isDeleted ? 'transparent'
    : isClient ? 'var(--ao-surface)'
    : (isBot ? 'rgba(186, 117, 23, 0.15)' : 'rgba(16, 185, 129, 0.18)')
  const border = isDeleted ? '1px dashed var(--ao-border)'
    : `1px solid ${isClient ? 'var(--ao-border)' : (isBot ? 'rgba(186, 117, 23, 0.35)' : 'rgba(16, 185, 129, 0.3)')}`
  const label = isClient ? null : (isBot ? 'Luna' : 'Equipe')
  const labelColor = isBot ? '#BA7517' : '#10B981'

  const content = msg.body || msg.content || ''
  const time = msg.created_at || msg.at
  const timeStr = time ? new Date(time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''

  const handleDelete = async () => {
    if (!canDelete || deleting) return
    setDeleting(true)
    try {
      const res = await deleteMessage(msg.id)
      if (res.warning) {
        alert(`Apagada localmente, mas: ${res.warning}`)
      }
      onDeleted?.(msg.id)
    } catch (e) {
      alert('Erro ao apagar: ' + e.message)
    } finally {
      setDeleting(false)
      setConfirmOpen(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isClient ? 'flex-start' : 'flex-end',
        marginBottom: 6,
        position: 'relative',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{
        maxWidth: '78%',
        padding: '7px 11px',
        borderRadius: 10,
        background: bg,
        border,
        fontSize: 13,
        lineHeight: 1.4,
        color: isDeleted ? 'var(--ao-text-dim)' : 'var(--ao-text-primary)',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        fontStyle: isDeleted ? 'italic' : 'normal',
        position: 'relative',
      }}>
        {label && !isDeleted && (
          <div style={{ fontSize: 10, fontWeight: 700, color: labelColor, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
            {label}
          </div>
        )}
        {isGroupMsg && author && !isDeleted && (
          <div style={{ fontSize: 10, fontWeight: 700, color: '#3B82F6', marginBottom: 2 }}>
            {author}
          </div>
        )}
        {isAudio && !isDeleted && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 10, color: '#10B981', fontWeight: 600,
            marginBottom: 3, padding: '2px 7px', borderRadius: 10,
            background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.25)',
          }}>
            <Mic size={9} />
            <span>Áudio transcrito{audioDuration ? ` · ${audioDuration}s` : ''}</span>
          </div>
        )}
        {content && content !== attachment?.filename ? (
          <div>{content}</div>
        ) : (!attachment && !isAudio && <em style={{ opacity: 0.4 }}>(mensagem sem texto)</em>)}
        {attachment && !isDeleted && (
          <AttachmentCard
            msgId={msg.id}
            attachment={attachment}
            accent={isClient ? 'var(--ao-accent, #c4956a)' : (isBot ? '#BA7517' : '#10B981')}
          />
        )}
        {timeStr && (
          <div style={{
            fontSize: 9.5, opacity: 0.55, marginTop: 3, textAlign: 'right',
            display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3,
          }}>
            {timeStr}
            {isDeleted && meta.deleted_at && (
              <span style={{ marginLeft: 4, color: 'var(--ao-text-dim)' }}> · apagada</span>
            )}
            {/* Ticks de ACK — so em msgs nossas (team/bot), nao cliente */}
            {!isClient && !isDeleted && ackStatus && (
              ackStatus === 'sent' ? <Check size={11} style={{ opacity: 0.7 }} title="Enviado" />
              : ackStatus === 'delivered' ? <CheckCheck size={11} style={{ opacity: 0.7 }} title="Entregue" />
              : (ackStatus === 'read' || ackStatus === 'played') ? <CheckCheck size={11} style={{ color: '#3B82F6', opacity: 1 }} title={ackStatus === 'played' ? 'Ouvido' : 'Lido'} />
              : null
            )}
          </div>
        )}

        {/* Botao apagar — visivel no hover desktop ou sempre em mobile (< 768px) */}
        {canDelete && !isDeleted && (
          <button
            onClick={() => setConfirmOpen(true)}
            title="Apagar mensagem"
            className="message-delete-btn"
            style={{
              position: 'absolute',
              top: -8,
              right: -8,
              width: 22, height: 22, borderRadius: '50%',
              background: 'var(--ao-card)', border: '1px solid var(--ao-border)',
              color: 'var(--ao-text-dim)',
              cursor: 'pointer',
              display: hovered ? 'flex' : 'none',
              alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
              padding: 0,
            }}
          >
            {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
          </button>
        )}
      </div>

      {/* Dialog de confirmacao */}
      {confirmOpen && (
        <div
          onClick={() => setConfirmOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 360, width: '100%',
              background: 'var(--ao-card)', borderRadius: 12,
              border: '1px solid var(--ao-border)', padding: 18,
              color: 'var(--ao-text-primary)',
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 6px' }}>Apagar mensagem?</h3>
            <p style={{ fontSize: 12, opacity: 0.7, margin: '0 0 14px' }}>
              Se enviada há menos de 1h, será removida pra todos no WhatsApp.
              Senão, fica marcada como apagada só aqui no painel.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
                style={{
                  padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                  border: '1px solid var(--ao-border)', background: 'transparent',
                  color: 'var(--ao-text-secondary)', cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 6,
                  border: 'none', background: '#ef4444', color: '#fff',
                  cursor: deleting ? 'wait' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                }}
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Apagar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
