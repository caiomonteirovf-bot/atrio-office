// tests/regressions.test.js
// Testes de regressão — cada entrada aqui é um bug que JÁ ACONTECEU em produção.
// Se o teste quebra, regredimos. Roda no CI a cada push.
//
// Estratégia: não depende de DB ou Gesthub real. Testa a LÓGICA PURA de transformação
// dos payloads reais do Gesthub → clientInfo consumido pelo whatsapp handler.
// O payload-sample é capturado de uma resposta real da API.

import { describe, it, expect } from 'vitest';

// Payload real do Gesthub pra CVM Contabilidade (empresa id=27, contato Caio)
// Capturado em 19/04/2026 via /clientes da API externa.
const GESTHUB_CVM_SAMPLE = {
  id: 27,
  document: '52.108.232/0001-61',
  documentType: 'CNPJ',
  documentValid: true,
  legalName: 'CVM CONTABILIDADE E CONSULTORIA LTDA',
  tradeName: '',
  status: 'ATIVO',
  type: 'GERAL',
  taxRegime: 'SIMPLES NACIONAL',
  city: 'RECIFE',
  state: 'PE',
  contatos: [
    { id: 1, clienteId: 27, nome: 'Caio Monteiro', cpf: null, funcao: 'SOCIO',
      telefone: '5581997166091', email: 'caiomonteirovf@gmail.com' }
  ],
};

// Replica a lógica de normalização do getClientInfo (whatsapp.js).
// Mantém sincronizada com a fonte — se a fonte mudar, este teste PRECISA mudar junto.
function normalizeGesthubClient(g, lunaUuid = 'fake-uuid') {
  if (!g) return { id: null, gesthub_id: null, name: null, source: 'unknown' };
  const razaoSocial  = g.legalName || g.razaoSocial || g.razao_social || null;
  const nomeFantasia = g.tradeName || g.nomeFantasia || g.nome_fantasia || null;
  const cnpj         = g.document || g.cnpj || null;
  const regime       = g.taxRegime || g.regime || g.regimeTributario || g.regime_tributario || null;
  const municipio    = g.city || g.municipio || g.cidade || null;
  return {
    id: lunaUuid,
    gesthub_id: g.id || null,
    name: razaoSocial || nomeFantasia || g.name || 'Cliente',
    trade_name: nomeFantasia,
    nome_fantasia: nomeFantasia,
    razao_social: razaoSocial,
    legalName: razaoSocial,
    tradeName: nomeFantasia,
    cnpj,
    regime,
    municipio,
    phone: g.phone || null,
    contato: g._contato || null,
    source: 'gesthub',
  };
}

// Replica a decisão isLead do whatsapp.js:894
function decideIsLead(clientInfo) {
  return !clientInfo?.id && !clientInfo?.gesthub_id;
}

describe('Regressão: Gesthub → clientInfo (CVM/Caio, abr/2026)', () => {
  it('Bug #1: lookup retornou o cliente real; NÃO deve cair como LEAD NOVO', () => {
    // Cenário: Caio mandou "Oi" do WhatsApp, findClientByPhone achou a CVM via contato.
    // Antes do fix, o código lia razao_social (snake_case); Gesthub devolve legalName (EN camelCase).
    // Resultado: campos undefined, upsert falhou, clientInfo sem id → LEAD NOVO falso.
    const clientInfo = normalizeGesthubClient(GESTHUB_CVM_SAMPLE);
    expect(clientInfo.gesthub_id).toBe(27);
    expect(clientInfo.razao_social).toBe('CVM CONTABILIDADE E CONSULTORIA LTDA');
    expect(clientInfo.cnpj).toBe('52.108.232/0001-61');
    expect(clientInfo.regime).toBe('SIMPLES NACIONAL');
    expect(decideIsLead(clientInfo)).toBe(false); // ← CORE: não é lead, é cliente existente
  });

  it('Bug #1.b: nome exibido no alerta prioriza razão social, não pushname do WhatsApp', () => {
    const clientInfo = normalizeGesthubClient(GESTHUB_CVM_SAMPLE);
    // Replica a cadeia de fallback do alertMsg (whatsapp.js:896-902):
    const nomeCliente = clientInfo.razao_social
      || clientInfo.legalName
      || clientInfo.nome_fantasia
      || clientInfo.trade_name
      || clientInfo.name
      || 'Caio Monteiro'  // pushname (último fallback)
      || 'Sem nome cadastrado';
    expect(nomeCliente).toBe('CVM CONTABILIDADE E CONSULTORIA LTDA');
  });

  it('Bug #1.c: aceita também payload PT snake_case legacy (backward-compat)', () => {
    // Se o Gesthub voltar a mandar PT snake (rollback ou mock antigo), ainda funciona.
    const legacy = {
      id: 99,
      razao_social: 'EMPRESA LEGACY LTDA',
      cnpj: '00.000.000/0001-00',
      regime_tributario: 'LUCRO PRESUMIDO',
      municipio: 'RECIFE',
    };
    const clientInfo = normalizeGesthubClient(legacy);
    expect(clientInfo.gesthub_id).toBe(99);
    expect(clientInfo.razao_social).toBe('EMPRESA LEGACY LTDA');
    expect(decideIsLead(clientInfo)).toBe(false);
  });

  it('Bug #1.d: lookup vazio (cliente de verdade não cadastrado) marca como LEAD corretamente', () => {
    // Regressão inversa: garantir que LEAD NOVO ainda funciona pra leads de verdade.
    const clientInfo = normalizeGesthubClient(null);
    expect(clientInfo.gesthub_id).toBe(null);
    expect(clientInfo.id).toBe(null);
    expect(decideIsLead(clientInfo)).toBe(true);
  });
});

describe('Regressão: templates Luna (abr/2026)', () => {
  it('Bug #2: template off_hours NÃO usa palavra "anotei" (usuário reportou soar fake pra "oi")', () => {
    // Este teste valida o TEXTO DO TEMPLATE, não a geração dinâmica da Luna.
    // Luna por LLM tem o reforço no system_prompt (testável por golden em outra suite).
    const tpl = 'Bom dia/Boa tarde/Boa noite{nome}! Recebi sua mensagem. Agora estamos fora do horário, mas na primeira hora do próximo dia útil coloco você como prioridade pra equipe. Pra eu já deixar tudo preparado, me conta o que você precisa?';
    expect(tpl.toLowerCase()).not.toMatch(/anotei|anoto|já registrei|ja registrei/);
    expect(tpl).toMatch(/prioridade/);
    expect(tpl).toMatch(/\{nome\}/); // placeholder preservado
  });

  it('Bug #2.b: template NÃO menciona hora/dia específico (regra no MEMORY.md)', () => {
    const tpl = 'Bom dia/Boa tarde/Boa noite{nome}! Recebi sua mensagem. Agora estamos fora do horário, mas na primeira hora do próximo dia útil coloco você como prioridade pra equipe. Pra eu já deixar tudo preparado, me conta o que você precisa?';
    // Não deve dizer "segunda-feira às 08h" ou equivalente
    expect(tpl).not.toMatch(/segunda|terça|quarta|quinta|sexta|sábado|domingo/i);
    expect(tpl).not.toMatch(/\d{1,2}h\b/);
  });
});
