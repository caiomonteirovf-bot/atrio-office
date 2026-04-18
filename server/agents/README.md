# Agentes do Átrio Office

> Cada subpasta é um agente. O arquivo `AGENTS.md` tem o **frontmatter YAML** (metadata + config de LLM) e o **body markdown** (system prompt).

## Agentes ativos

- [André](andre/AGENTS.md) — Analista de TI (tecnologia) · model: deepseek-chat
- [Campelo](campelo/AGENTS.md) — Analista fiscal (fiscal) · model: claude-sonnet-4-5-20250929
- [Luna](luna/AGENTS.md) — Analista de Atendimento Virtual (atendimento) · model: x-ai/grok-4-fast
- [Rodrigo](rodrigo/AGENTS.md) — Diretor de operações (diretoria) · model: grok-4-1-fast
- [Saldanha](saldanha/AGENTS.md) — Analista societário (societario) · model: grok-4-1-fast
- [Sneijder](sneijder/AGENTS.md) — Analista financeiro (financeiro) · model: grok-4-1-fast

## Como editar

1. Abra o `AGENTS.md` do agente
2. Edite o prompt no body ou ajuste frontmatter (model, budget, tools)
3. Commit no git
4. Reinicie o servidor: `docker restart atrio-office-server-1`
5. O loader sincroniza com o DB no boot

## Criando um agente novo

```bash
cp -r luna/ natalia/
# editar natalia/AGENTS.md: trocar id (gerar novo uuid), name, role, prompt
# reiniciar server
```
