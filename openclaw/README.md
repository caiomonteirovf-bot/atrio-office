# OpenClaw Integration — Átrio Contabilidade

Integração da Luna (agente de atendimento) com o ecossistema [OpenClaw](https://github.com/openclaw/openclaw).

## Estrutura

```
openclaw/
├── README.md              # Este arquivo
├── openclaw.json          # Config do OpenClaw (copiar para ~/.openclaw/)
└── skills/
    └── atrio-luna/
        └── SKILL.md       # Skill da Luna para OpenClaw
```

## O que é o OpenClaw?

OpenClaw é um assistente pessoal de IA open source (355k+ stars) que roda nos seus dispositivos e se conecta a qualquer app de mensagens (WhatsApp, Telegram, Slack, Discord, Signal, etc.).

Site: https://openclaw.ai | Docs: https://docs.openclaw.ai

## Por que integrar?

A Luna hoje funciona apenas via WhatsApp (whatsapp-web.js). Com o OpenClaw, ela ganha:

- **Multi-canal:** WhatsApp + Telegram + Discord + Slack + WebChat + 20+ canais
- **Voice Mode:** Clientes podem falar por voz (macOS/iOS/Android)
- **Canvas Visual:** Dashboards ao vivo para o cliente
- **Escalation nativo:** Sistema de escalation robusto embutido
- **Skills ecosystem:** Acesso ao ClawHub com 5.400+ skills adicionais
- **Apps companion:** macOS menu bar + iOS/Android nodes

## Como implementar

### 1. Instalar OpenClaw

```bash
npm install -g openclaw@latest
```

### 2. Copiar configuração

```bash
cp openclaw/openclaw.json ~/.openclaw/openclaw.json
```

### 3. Copiar skill da Luna

```bash
mkdir -p ~/.openclaw/workspace/skills/atrio-luna
cp openclaw/skills/atrio-luna/SKILL.md ~/.openclaw/workspace/skills/atrio-luna/
```

### 4. Configurar e rodar

```bash
openclaw onboard --install-daemon
openclaw gateway --port 18789 --verbose
```

### 5. Testar

```bash
openclaw agent --message "Preciso emitir uma nota fiscal"
```

## Pré-requisitos

- Node.js 24 (recomendado) ou Node.js 22.16+
- Backend Átrio Office rodando (porta 3010)
- API acessível na URL configurada em ATRIO_API_URL

## Configuração de canais adicionais

Edite `~/.openclaw/openclaw.json` para habilitar outros canais:

**Telegram:**
```json
"telegram": { "botToken": "SEU_TOKEN" }
```

**Discord:**
```json
"discord": { "token": "SEU_TOKEN" }
```

## Status: Para implementação futura

Esta integração está documentada e pronta para ser implementada quando o time decidir avançar.
