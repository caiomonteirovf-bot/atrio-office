import { useRef, useEffect, useState, useCallback } from 'react'
import { useAgents } from '../hooks/useAgents'
import { COLORS, AGENT_COLORS, DESKS, AVATAR_POSITIONS, DECORATIONS, OFFICE_BOUNDS, WAYPOINTS } from './OfficeMap'

const AVATAR_RADIUS = 20
const SCALE = 1

function hexToRgb(hex) {
  return {
    r: (hex >> 16) & 0xFF,
    g: (hex >> 8) & 0xFF,
    b: hex & 0xFF,
  }
}

function hexToCSS(hex) {
  const { r, g, b } = hexToRgb(hex)
  return `rgb(${r},${g},${b})`
}

function hexToCSSAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

export default function VirtualOffice({ onSelectAgent }) {
  const canvasRef = useRef(null)
  const animRef = useRef(null)
  const stateRef = useRef({
    avatars: {},
    renderedPositions: {}, // screen-space positions after transform
    hoveredAvatar: null,
    time: 0,
  })
  const { agents } = useAgents()

  // Initialize avatar positions
  useEffect(() => {
    if (!agents.length) return
    const state = stateRef.current
    agents.forEach(agent => {
      const pos = AVATAR_POSITIONS[agent.name]
      if (pos && !state.avatars[agent.name]) {
        state.avatars[agent.name] = {
          x: pos.x,
          y: pos.y,
          targetX: pos.x,
          targetY: pos.y,
          homeX: pos.x,
          homeY: pos.y,
          color: AGENT_COLORS[agent.name]?.primary || 0x888888,
          letter: agent.config?.avatar_letter || agent.name[0],
          role: agent.role,
          status: agent.status,
          id: agent.id,
          isMoving: false,
          wanderTimer: Math.random() * 600 + 300,
          atHome: true,
        }
      }
    })
    // Add humans
    ;['Deyvison', 'Diego'].forEach(name => {
      const pos = AVATAR_POSITIONS[name]
      if (pos && !state.avatars[name]) {
        state.avatars[name] = {
          x: pos.x, y: pos.y,
          targetX: pos.x, targetY: pos.y,
          homeX: pos.x, homeY: pos.y,
          color: AGENT_COLORS[name]?.primary || 0x888888,
          letter: name[0],
          role: name === 'Deyvison' ? 'Coordenador operacional' : 'Assistente contábil',
          status: 'available',
          id: null,
          isMoving: false,
          wanderTimer: Math.random() * 800 + 400,
          atHome: true,
        }
      }
    })
  }, [agents])

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function resize() {
      const parent = canvas.parentElement
      canvas.width = parent.clientWidth
      canvas.height = parent.clientHeight
    }
    resize()
    window.addEventListener('resize', resize)

    // Draws floor, walls, grid — called inside the main transform
    function drawFloor() {
      const ob = OFFICE_BOUNDS

      // Floor tiles
      const tileSize = 40
      for (let x = ob.x; x < ob.x + ob.width; x += tileSize) {
        for (let y = ob.y; y < ob.y + ob.height; y += tileSize) {
          const alt = ((x / tileSize + y / tileSize) % 2 === 0)
          ctx.fillStyle = hexToCSS(alt ? COLORS.floor : COLORS.floorAlt)
          ctx.fillRect(x, y, tileSize, tileSize)
        }
      }

      // Grid lines
      ctx.strokeStyle = hexToCSSAlpha(COLORS.gridLine, 0.3)
      ctx.lineWidth = 0.5
      for (let x = ob.x; x <= ob.x + ob.width; x += tileSize) {
        ctx.beginPath()
        ctx.moveTo(x, ob.y)
        ctx.lineTo(x, ob.y + ob.height)
        ctx.stroke()
      }
      for (let y = ob.y; y <= ob.y + ob.height; y += tileSize) {
        ctx.beginPath()
        ctx.moveTo(ob.x, y)
        ctx.lineTo(ob.x + ob.width, y)
        ctx.stroke()
      }

      // Walls
      ctx.strokeStyle = hexToCSSAlpha(COLORS.wall, 0.6)
      ctx.lineWidth = 3
      ctx.strokeRect(ob.x, ob.y, ob.width, ob.height)
    }

    function drawDesk(x, y, w, h, sectorColor, label) {
      // Desk shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.beginPath()
      ctx.roundRect(x + 3, y + 3, w, h, 6)
      ctx.fill()

      // Desk body
      const grad = ctx.createLinearGradient(x, y, x, y + h)
      grad.addColorStop(0, hexToCSS(COLORS.deskTop))
      grad.addColorStop(1, hexToCSS(COLORS.desk))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 6)
      ctx.fill()

      // Sector accent line
      ctx.strokeStyle = hexToCSSAlpha(sectorColor, 0.4)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 6)
      ctx.stroke()

      // Monitor
      const mw = 24, mh = 16
      ctx.fillStyle = hexToCSS(COLORS.monitorScreen)
      ctx.fillRect(x - mw / 2, y - h / 2 + 8, mw, mh)
      // Monitor glow
      ctx.shadowColor = hexToCSSAlpha(COLORS.monitorGlow, 0.3)
      ctx.shadowBlur = 12
      ctx.fillStyle = hexToCSSAlpha(COLORS.monitorGlow, 0.15)
      ctx.fillRect(x - mw / 2, y - h / 2 + 8, mw, mh)
      ctx.shadowBlur = 0

      // Desk lamp light cone
      ctx.fillStyle = hexToCSSAlpha(COLORS.lightWarm, 0.04)
      ctx.beginPath()
      ctx.arc(x, y, 55, 0, Math.PI * 2)
      ctx.fill()

      // Sector label
      if (label) {
        ctx.font = '9px system-ui'
        ctx.fillStyle = hexToCSSAlpha(sectorColor, 0.5)
        ctx.textAlign = 'center'
        ctx.fillText(label, x, y - h / 2 - 6)
      }
    }

    function drawDecoration(dec) {
      if (dec.type === 'plant') {
        // Pot
        ctx.fillStyle = '#4A3728'
        ctx.beginPath()
        ctx.roundRect(dec.x - 8, dec.y + 5, 16, 12, 3)
        ctx.fill()
        // Leaves
        for (let i = 0; i < 5; i++) {
          const angle = (i / 5) * Math.PI * 2 + stateRef.current.time * 0.001
          const lx = dec.x + Math.cos(angle) * 10
          const ly = dec.y - 2 + Math.sin(angle) * 6
          ctx.fillStyle = i % 2 === 0 ? hexToCSS(COLORS.plant) : hexToCSS(COLORS.plantDark)
          ctx.beginPath()
          ctx.arc(lx, ly, 6, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (dec.type === 'sofa') {
        ctx.fillStyle = hexToCSS(COLORS.sofa)
        ctx.beginPath()
        ctx.roundRect(dec.x - dec.w / 2, dec.y - dec.h / 2, dec.w, dec.h, 10)
        ctx.fill()
        ctx.strokeStyle = hexToCSSAlpha(0x4B5563, 0.5)
        ctx.lineWidth = 1
        ctx.stroke()
      } else if (dec.type === 'coffee') {
        // Coffee machine
        ctx.fillStyle = '#2D2D2D'
        ctx.beginPath()
        ctx.roundRect(dec.x - 10, dec.y - 12, 20, 24, 4)
        ctx.fill()
        // Red light
        ctx.fillStyle = '#EF4444'
        ctx.beginPath()
        ctx.arc(dec.x, dec.y - 6, 2, 0, Math.PI * 2)
        ctx.fill()
        // Cup
        ctx.fillStyle = '#F5F5F5'
        ctx.fillRect(dec.x - 4, dec.y + 4, 8, 6)
      }
    }

    function drawAvatar(name, avatar, isHovered) {
      const { x, y, color, letter, status } = avatar
      const time = stateRef.current.time
      const breathe = 1 + Math.sin(time * 0.003 + x * 0.01) * 0.03
      const scale = isHovered ? 1.15 : breathe
      const r = AVATAR_RADIUS * scale

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.beginPath()
      ctx.ellipse(x, y + r * 0.7, r * 0.8, r * 0.3, 0, 0, Math.PI * 2)
      ctx.fill()

      // Glow (hover or status)
      if (isHovered) {
        ctx.shadowColor = hexToCSSAlpha(color, 0.6)
        ctx.shadowBlur = 20
      }

      // Avatar body — gradient circle
      const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r)
      const { r: cr, g: cg, b: cb } = hexToRgb(color)
      grad.addColorStop(0, `rgb(${Math.min(cr + 40, 255)},${Math.min(cg + 40, 255)},${Math.min(cb + 40, 255)})`)
      grad.addColorStop(1, hexToCSS(color))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()

      // Border
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.shadowBlur = 0

      // Status ring
      if (status === 'online' || status === 'available') {
        const pulseAlpha = 0.4 + Math.sin(time * 0.005) * 0.3
        ctx.strokeStyle = `rgba(74, 222, 128, ${pulseAlpha})`
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(x, y, r + 4, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Letter
      ctx.font = `bold ${Math.round(r * 0.9)}px system-ui`
      ctx.fillStyle = 'white'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 3
      ctx.fillText(letter, x, y + 1)
      ctx.shadowBlur = 0

      // Name label
      const labelY = y + r + 14
      ctx.font = '11px system-ui'
      const tw = ctx.measureText(name).width
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.beginPath()
      ctx.roundRect(x - tw / 2 - 6, labelY - 8, tw + 12, 16, 4)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(name, x, labelY)

      // Tooltip on hover
      if (isHovered) {
        const tooltipY = y - r - 22
        const role = avatar.role
        ctx.font = '10px system-ui'
        const rtw = ctx.measureText(role).width
        ctx.fillStyle = hexToCSSAlpha(color, 0.9)
        ctx.beginPath()
        ctx.roundRect(x - rtw / 2 - 8, tooltipY - 9, rtw + 16, 18, 6)
        ctx.fill()
        ctx.fillStyle = 'white'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(role, x, tooltipY)
      }
    }

    function updateAvatars() {
      const state = stateRef.current
      state.time++

      Object.entries(state.avatars).forEach(([name, av]) => {
        // Move towards target
        const dx = av.targetX - av.x
        const dy = av.targetY - av.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist > 1) {
          av.x += dx * 0.04
          av.y += dy * 0.04
          av.isMoving = true
        } else {
          av.isMoving = false
          // Wander timer
          av.wanderTimer--
          if (av.wanderTimer <= 0) {
            if (av.atHome) {
              // Go to random waypoint
              const wp = WAYPOINTS[Math.floor(Math.random() * WAYPOINTS.length)]
              av.targetX = wp.x + (Math.random() - 0.5) * 30
              av.targetY = wp.y + (Math.random() - 0.5) * 30
              av.atHome = false
              av.wanderTimer = 200 + Math.random() * 200
            } else {
              // Go home
              av.targetX = av.homeX
              av.targetY = av.homeY
              av.atHome = true
              av.wanderTimer = 400 + Math.random() * 600
            }
          }
        }
      })
    }

    function render() {
      const w = canvas.width
      const h = canvas.height

      const scaleX = w / 810
      const scaleY = h / 600
      const sc = Math.min(scaleX, scaleY)

      ctx.clearRect(0, 0, w, h)

      // Background fill
      ctx.fillStyle = hexToCSS(COLORS.bg)
      ctx.fillRect(0, 0, w, h)

      // Apply uniform transform
      ctx.save()
      ctx.translate((w - 810 * sc) / 2, (h - 600 * sc) / 2)
      ctx.scale(sc, sc)

      // Floor & walls
      drawFloor()

      // Desks
      DESKS.forEach(desk => drawDesk(desk.x, desk.y, desk.w, desk.h, desk.sectorColor, desk.label))

      // Decorations
      DECORATIONS.forEach(dec => drawDecoration(dec))

      // Avatars (sorted by Y for depth)
      const state = stateRef.current
      const sortedAvatars = Object.entries(state.avatars).sort((a, b) => a[1].y - b[1].y)
      sortedAvatars.forEach(([name, av]) => {
        // Store rendered screen position for hit testing
        const screenX = (w - 810 * sc) / 2 + av.x * sc
        const screenY = (h - 600 * sc) / 2 + av.y * sc
        state.renderedPositions[name] = { x: screenX, y: screenY, radius: AVATAR_RADIUS * sc }
        drawAvatar(name, av, state.hoveredAvatar === name)
      })

      // Ambient particles
      for (let i = 0; i < 8; i++) {
        const px = (Math.sin(state.time * 0.001 + i * 1.7) * 0.5 + 0.5) * 750 + 30
        const py = (Math.cos(state.time * 0.0008 + i * 2.3) * 0.5 + 0.5) * 550 + 25
        const alpha = 0.1 + Math.sin(state.time * 0.003 + i) * 0.08
        ctx.fillStyle = `rgba(252, 211, 77, ${alpha})`
        ctx.beginPath()
        ctx.arc(px, py, 2, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()

      updateAvatars()
      animRef.current = requestAnimationFrame(render)
    }

    animRef.current = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [agents])


  const findAvatarAtScreen = useCallback((screenX, screenY) => {
    const state = stateRef.current
    let closest = null
    let closestDist = Infinity
    Object.entries(state.renderedPositions).forEach(([name, pos]) => {
      const dx = screenX - pos.x
      const dy = screenY - pos.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < pos.radius + 10 && dist < closestDist) {
        closestDist = dist
        closest = name
      }
    })
    return closest
  }, [])

  // Convert CSS pixel coords to canvas pixel coords
  const cssToCanvas = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: cssX, y: cssY }
    const rect = canvas.getBoundingClientRect()
    return {
      x: cssX * (canvas.width / rect.width),
      y: cssY * (canvas.height / rect.height),
    }
  }, [])

  // Mouse interaction — hit test using rendered screen positions
  const handleMouseMove = useCallback((e) => {
    const { x, y } = cssToCanvas(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    const found = findAvatarAtScreen(x, y)
    stateRef.current.hoveredAvatar = found
    if (canvasRef.current) canvasRef.current.style.cursor = found ? 'pointer' : 'default'
  }, [findAvatarAtScreen, cssToCanvas])

  const handleClick = useCallback((e) => {
    const { x, y } = cssToCanvas(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
    const found = findAvatarAtScreen(x, y)
    if (found) {
      const av = stateRef.current.avatars[found]
      if (av.id) {
        const agent = agents.find(a => a.id === av.id)
        if (agent) onSelectAgent(agent)
      }
    }
  }, [agents, onSelectAgent, findAvatarAtScreen, cssToCanvas])

  return (
    <canvas
      ref={canvasRef}
      onMouseMove={handleMouseMove}
      onClick={handleClick}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
