// Layout do escritório virtual — coordenadas e posições

export const COLORS = {
  bg: 0x0D1117,
  floor: 0x1B2332,
  floorAlt: 0x1E2738,
  wall: 0x2D3748,
  desk: 0x2A1F14,
  deskTop: 0x3D2B1A,
  monitor: 0x1A2332,
  monitorGlow: 0x4B9EF5,
  monitorScreen: 0x0F1923,
  chair: 0x1A1A2E,
  plant: 0x4ADE80,
  plantDark: 0x22C55E,
  sofa: 0x374151,
  carpet: 0x1E293B,
  lightWarm: 0xFCD34D,
  gridLine: 0x1A2030,
}

export const AGENT_COLORS = {
  Rodrigo: { primary: 0xE8A955, glow: 0xE8A955 },
  Campelo: { primary: 0x4B9EF5, glow: 0x4B9EF5 },
  Sneijder: { primary: 0x34D399, glow: 0x34D399 },
  Luna: { primary: 0xF59E0B, glow: 0xF59E0B },
  Sofia: { primary: 0xA78BFA, glow: 0xA78BFA },
  Deyvison: { primary: 0x94A3B8, glow: 0x94A3B8 },
  Diego: { primary: 0x64748B, glow: 0x64748B },
}

// Mesas: posição, tamanho, orientação
export const DESKS = [
  // Diretoria — Rodrigo (centro-topo, mesa maior)
  { id: 'rodrigo', x: 400, y: 120, w: 100, h: 50, label: 'Diretoria', sectorColor: 0xE8A955 },
  // Fiscal — Campelo (esquerda)
  { id: 'campelo', x: 120, y: 280, w: 85, h: 45, label: 'Fiscal', sectorColor: 0x4B9EF5 },
  // Financeiro — Sneijder (centro-esquerda)
  { id: 'sneijder', x: 320, y: 280, w: 85, h: 45, label: 'Financeiro', sectorColor: 0x34D399 },
  // Atendimento — Luna (entrada, parte inferior)
  { id: 'luna', x: 150, y: 440, w: 85, h: 45, label: 'Atendimento', sectorColor: 0xF59E0B },
  // Societário — Sofia (direita)
  { id: 'sofia', x: 520, y: 280, w: 85, h: 45, label: 'Societário', sectorColor: 0xA78BFA },
  // Operacional — Deyvison e Diego (direita-inferior)
  { id: 'deyvison', x: 520, y: 440, w: 75, h: 40, label: 'Operacional', sectorColor: 0x94A3B8 },
  { id: 'diego', x: 650, y: 440, w: 75, h: 40, label: '', sectorColor: 0x64748B },
]

// Posições dos avatares (sentados atrás da mesa)
export const AVATAR_POSITIONS = {
  Rodrigo: { x: 400, y: 185, deskId: 'rodrigo' },
  Campelo: { x: 120, y: 345, deskId: 'campelo' },
  Sneijder: { x: 320, y: 345, deskId: 'sneijder' },
  Luna: { x: 150, y: 505, deskId: 'luna' },
  Sofia: { x: 520, y: 345, deskId: 'sofia' },
  Deyvison: { x: 520, y: 505, deskId: 'deyvison' },
  Diego: { x: 650, y: 505, deskId: 'diego' },
}

// Decoração
export const DECORATIONS = [
  // Plantas
  { type: 'plant', x: 50, y: 80 },
  { type: 'plant', x: 750, y: 80 },
  { type: 'plant', x: 50, y: 550 },
  { type: 'plant', x: 750, y: 400 },
  // Sofá na área comum
  { type: 'sofa', x: 650, y: 160, w: 80, h: 35 },
  // Máquina de café
  { type: 'coffee', x: 740, y: 250 },
]

// Paredes e limites do escritório
export const OFFICE_BOUNDS = {
  x: 20,
  y: 20,
  width: 770,
  height: 560,
}

// Waypoints para movimento aleatório
export const WAYPOINTS = [
  { x: 400, y: 350, label: 'corredor' },
  { x: 650, y: 180, label: 'sofá' },
  { x: 740, y: 260, label: 'café' },
  { x: 400, y: 500, label: 'entrada' },
  { x: 250, y: 350, label: 'corredor2' },
]
