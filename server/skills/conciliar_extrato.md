---
name: conciliar_extrato
version: 1.0.0
category: financeiro
description: Concilia um extrato bancário (OFX/CSV/PDF) com os lançamentos existentes no Átrio Finance, aplica auto-classificação e gera relatório de itens pendentes.
allowed_agents: [Sneijder, Luna, Campelo]
inputs:
  cliente_id:
    type: integer
    required: true
    description: ID do cliente no Gesthub
  upload_id:
    type: integer
    required: true
    description: ID do upload já processado no Finance
  ano:
    type: integer
    required: true
  mes:
    type: integer
    required: true
outputs:
  transacoes_importadas: integer
  transacoes_classificadas: integer
  transacoes_pendentes: integer
  duplicatas_ignoradas: integer
  report_url: string
success_criteria:
  - Todas as transações do extrato importadas sem erro
  - Auto-classificação com confiança > 70% aplicada
  - Itens pendentes (<70% confiança) listados para revisão manual
  - Saldo do extrato bate com soma das transações
---

# Skill: conciliar_extrato

## Contexto
Extratos entram pelo **Átrio Finance** via `POST /api/uploads`. Este skill roda DEPOIS da importação — ele classifica, detecta duplicatas e gera o relatório de revisão.

## Passos

### 1. Validar upload
- `GET /api/uploads/{upload_id}` — confirma que `status == 'imported'`
- Se `status == 'error'` → parar e escalar para Sneijder
- Confirmar que `periodo_inicio`/`periodo_fim` cobrem o mês solicitado

### 2. Auto-classificação
- Para cada transação sem categoria, aplicar em ordem:
  1. **Regras exatas** do cliente (`cliente_categorias` table) — match por descrição regex
  2. **Padrões globais** (`categorias_dre.padroes_descricao`) — ex: "DARF", "INSS", "Água", "Luz"
  3. **Similaridade semântica** com transações anteriores do mesmo cliente (embedding)
- Confiança da classificação: exata=1.0, padrão=0.85, semântica=0.6-0.9

### 3. Detecção de duplicatas
- Dentro da mesma conta e mês, duas transações com:
  - Mesmo valor E
  - Mesma data E
  - Descrição similar (Levenshtein > 0.85)
- Marca a segunda como `duplicata_possivel` (requer revisão humana, **NUNCA deleta**)

### 4. Conferência de saldo
- Soma das transações no período = `saldo_final - saldo_inicial` do OFX
- Se diferença > R$ 0,01: escalar — provável erro de parser

### 5. Gerar relatório
- `GET /api/finance/relatorio/{cliente_id}/{ano}/{mes}` → HTML
- Destacar:
  - ✅ Classificadas automaticamente (confiança ≥ 70%)
  - ⚠️ Requerem revisão (confiança < 70%)
  - 🔴 Duplicatas possíveis
  - 🔴 Saldo não bate (se houver)

### 6. Ação de follow-up
- Se há itens pendentes: criar task para Sneijder revisar
- Se saldo bate e 100% classificado: marcar mês como `conciliado=true` no cliente

## Critérios de falha
- Extrato de competência diferente do esperado → bloquear + notificar
- Conta bancária não encontrada no cliente → criar automaticamente (regra existente)
- Mais de 20% de transações sem classificação → indica regras desatualizadas, escalar para Sneijder

## Retorno esperado (JSON)

```json
{
  "transacoes_importadas": 197,
  "transacoes_classificadas": 180,
  "transacoes_pendentes": 17,
  "duplicatas_ignoradas": 2,
  "saldo_ok": true,
  "report_url": "/api/finance/relatorio/38/2026/4"
}
```
