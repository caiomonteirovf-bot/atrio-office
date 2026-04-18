---
name: emitir_nfse
version: 1.0.0
category: fiscal
description: Emite NFS-e para cliente via API Nuvem Fiscal, orquestrando validação, envio DPS e registro no Gesthub.
allowed_agents: [Campelo, Luna]
inputs:
  cliente_cnpj:
    type: string
    required: true
    description: CNPJ do tomador (14 dígitos, com ou sem formatação)
  valor_servico:
    type: number
    required: true
    description: Valor total do serviço em reais
  descricao_servico:
    type: string
    required: true
    description: Descrição do serviço prestado
  codigo_municipal:
    type: string
    required: false
    description: Código de tributação municipal (se omitido, usa default do prestador)
outputs:
  numero_nfse: string
  chave_acesso: string
  url_pdf: string
  status: emitida | rejeitada | processando
success_criteria:
  - NFS-e com número sequencial atribuído pelo município
  - Retenções federais calculadas corretamente (IRRF, CSLL, INSS, PIS/COFINS quando aplicável)
  - Registro criado no Gesthub com link do PDF
---

# Skill: emitir_nfse

## Contexto
Você está emitindo uma NFS-e usando a integração **Nuvem Fiscal** (produção, sandbox para testes).
Referência: `reference_nuvem_fiscal_creds.md` e `project_nfse_emissao_sandbox.md`.

## Passos

### 1. Validação do tomador
- Consultar `consultar_tomador(cliente_cnpj)` no Gesthub
- Se não encontrado → **parar** e retornar erro: "Tomador não cadastrado. Crie no Gesthub antes de emitir."
- Validar que CNPJ tem 14 dígitos numéricos válidos

### 2. Cálculo das retenções federais
- Se `valor_servico >= 215.05`: aplicar retenções (IRRF 1,5%, CSLL 1%, PIS 0,65%, COFINS 3%)
- Se tomador é MEI ou PF: não retém
- Referência: `reference_guia_emissor_nacional.md`

### 3. Montar payload DPS
- `prestador`: dados fixos do escritório (CNPJ, IM, endereço de Recife)
- `tomador`: dados do Gesthub
- `servico`: descrição, valor, código municipal (default: 101 — consultoria contábil)
- `competencia`: mês corrente
- `serie_numerica`: série configurada no sistema

### 4. Enviar DPS via Nuvem Fiscal
- `POST /api/nuvem-fiscal/emitir`
- Aguardar confirmação (pode ser assíncrono)
- Salvar chave de acesso e número na tabela `nfse_emitidas`

### 5. Registrar no Gesthub
- Criar documento na pasta do cliente com link do PDF
- Atualizar status do cliente: `ultima_nfse_emitida_em = NOW()`

### 6. Notificar equipe (NÃO o cliente — regra `feedback_nfse_notificacao`)
- Se sucesso: chat interno "NFS-e {numero} emitida para {cliente} — R$ {valor}"
- Se falha: chat interno + task para Diogo revisar manualmente

## Critérios de falha

- Certificado A1 vencido → bloquear emissão e criar task para renovação
- Tomador sem inscrição municipal quando exigido → solicitar via Luna no WhatsApp
- Valor abaixo de R$ 0,01 → rejeitar

## Retorno esperado (JSON)

```json
{
  "status": "emitida",
  "numero_nfse": "2026-0001234",
  "chave_acesso": "35...",
  "url_pdf": "https://nuvemfiscal.com.br/...",
  "retencoes_aplicadas": { "irrf": 30.00, "csll": 20.00 }
}
```
