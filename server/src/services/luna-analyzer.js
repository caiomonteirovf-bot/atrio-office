import { chatWithAgent } from './claude.js';
import { query } from '../db/pool.js';
import * as gesthub from './gesthub.js';

const LUNA_AGENT_ID = 'a0000001-0000-0000-0000-000000000004';

// Mapa sentimento → NPS score base (usado quando a IA não dá score)
const SENTIMENT_NPS = {
  satisfeito: 9,
  neutro: 7,
  insatisfeito: 4,
  irritado: 2,
  ansioso: 5,
};

/**
 * Luna analisa a conversa completa entre cliente e equipe.
 * Retorna: demanda atendida? sentimento? urgência? score NPS estimado?
 */
export async function analyzeConversation(messages, clientName) {
  try {
    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [LUNA_AGENT_ID]);
    if (!agents.length) return null;

    // Monta o histórico da conversa para análise
    const transcript = messages.map(m => {
      const who = m.from === 'client' ? clientName : 'Equipe';
      return `[${who}]: ${m.body}`;
    }).join('\n');

    const prompt = `Analise esta conversa entre um cliente e nossa equipe de contabilidade.

CONVERSA:
${transcript}

Responda APENAS em JSON válido com esta estrutura:
{
  "demanda_original": "resumo do que o cliente pediu",
  "demanda_atendida": true/false,
  "motivo": "explicação se não foi atendida ou se foi atendida parcialmente",
  "sentimento_cliente": "satisfeito" | "neutro" | "insatisfeito" | "irritado" | "ansioso",
  "urgencia": "baixa" | "media" | "alta" | "critica",
  "nps_estimado": 0-10,
  "precisa_followup": true/false,
  "followup_sugerido": "ação recomendada se precisa de follow-up",
  "tags": ["lista", "de", "tags", "relevantes"]
}`;

    const response = await chatWithAgent(
      { ...agents[0], tools: [] }, // sem tools, só análise
      [{ role: 'user', content: prompt }]
    );

    if (!response.success || !response.text) return null;

    // Extrai JSON da resposta
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[Luna Analyzer] Erro:', err.message);
    return null;
  }
}

/**
 * Registra análise como pesquisa NPS no Gesthub
 */
export async function registerNPS(analysis, clientPhone, clientName) {
  try {
    // Tenta encontrar o cliente no Gesthub pelo nome
    const clients = await gesthub.getClients();
    const client = clients.find(c =>
      c.legalName?.toLowerCase().includes(clientName.toLowerCase()) ||
      clientName.toLowerCase().includes(c.legalName?.split(' ')[0]?.toLowerCase() || '---')
    );

    const npsData = {
      cliente_id: client?.id || null,
      tipo: 'WHATSAPP_AUTOMATICO',
      dimensao: 'ATENDIMENTO',
      nota: analysis.nps_estimado ?? SENTIMENT_NPS[analysis.sentimento_cliente] ?? 7,
      comentario: [
        `Análise automática Luna (WhatsApp)`,
        `Cliente: ${clientName} (${clientPhone})`,
        `Demanda: ${analysis.demanda_original}`,
        `Atendida: ${analysis.demanda_atendida ? 'Sim' : 'NÃO'}`,
        `Sentimento: ${analysis.sentimento_cliente}`,
        `Urgência: ${analysis.urgencia}`,
        analysis.motivo ? `Motivo: ${analysis.motivo}` : '',
        analysis.followup_sugerido ? `Follow-up: ${analysis.followup_sugerido}` : '',
        analysis.tags?.length ? `Tags: ${analysis.tags.join(', ')}` : '',
      ].filter(Boolean).join('\n'),
    };

    const result = await gesthub.createNPS(npsData);
    console.log(`[Luna NPS] Registrado para ${clientName}: score=${npsData.nota}, atendida=${analysis.demanda_atendida}`);
    return result;
  } catch (err) {
    console.error('[Luna NPS] Erro ao registrar:', err.message);
    return null;
  }
}

/**
 * Classifica a demanda do cliente por setor e sugere atendente.
 * Roda na primeira mensagem para direcionar corretamente.
 */
export async function classifyDemand(message, clientName) {
  try {
    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [LUNA_AGENT_ID]);
    if (!agents.length) return null;

    const prompt = `Você é a Luna, gestora de atendimento de um escritório de contabilidade. Classifique a demanda do cliente abaixo.

Cliente: ${clientName}
Mensagem: "${message}"

Responda APENAS em JSON:
{
  "classificacao": "fiscal" | "financeiro" | "societario" | "atendimento" | "comercial" | "pessoal" | "geral",
  "prioridade": "low" | "medium" | "high" | "urgent",
  "resumo": "resumo em 1 frase da demanda",
  "atendente_sugerido": "Deyvison" | "Diego" | "Diogo" | "Karla" | "Quésia" | "Rafaela" | "Caio" | "equipe",
  "motivo_atribuicao": "por que esse atendente"
}

Regras de atribuição:
- Fiscal (impostos, DAS, NFS-e, DCTF, SPED, guias, certidões) → Deyvison, Diego ou Karla
- Financeiro (honorários, pagamentos, cobranças, boletos) → Diogo
- Societário (contrato social, alteração, abertura, encerramento) → Deyvison
- Pessoal (folha de pagamento, férias, rescisão, FGTS, eSocial) → Rafaela
- Comercial (proposta, preço, contratação de serviço) → Caio
- Atendimento (dúvida simples, documento, senha, suporte geral) → Quésia
- Geral (saudação, agradecimento, sem demanda clara) → equipe`;

    const response = await chatWithAgent(
      { ...agents[0], tools: [] },
      [{ role: 'user', content: prompt }]
    );

    if (!response.success || !response.text) return null;
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[Luna Classifier] Erro:', err.message);
    return null;
  }
}

/**
 * Analisa sentimento de uma única mensagem (rápido)
 */
export async function analyzeSentiment(message, context) {
  try {
    const { rows: agents } = await query('SELECT * FROM agents WHERE id = $1', [LUNA_AGENT_ID]);
    if (!agents.length) return null;

    const prompt = `Analise rapidamente esta mensagem de um cliente:

"${message}"

${context ? `Contexto: ${context}` : ''}

Responda APENAS em JSON:
{
  "sentimento": "satisfeito" | "neutro" | "insatisfeito" | "irritado" | "ansioso",
  "urgencia": "baixa" | "media" | "alta" | "critica",
  "precisa_atencao_imediata": true/false,
  "resumo": "resumo em 1 frase do que o cliente quer"
}`;

    const response = await chatWithAgent(
      { ...agents[0], tools: [] },
      [{ role: 'user', content: prompt }]
    );

    if (!response.success || !response.text) return null;

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('[Luna Analyzer] Erro sentimento:', err.message);
    return null;
  }
}
