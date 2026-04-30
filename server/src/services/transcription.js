/**
 * Transcription service — usa OpenAI Whisper pra audios do WhatsApp.
 * Custo: $0.006/minuto (~R$ 0,03/min). Audio tipico (30s) = R$ 0,015.
 * Latencia: 3-8s dependendo do tamanho.
 */
import FormData from 'form-data';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Transcreve um buffer de audio (OGG/OPUS do WhatsApp) pra texto.
 * @param {Buffer} audioBuffer
 * @param {string} mimeType  ex: 'audio/ogg; codecs=opus'
 * @param {string} filenameHint ex: 'msg.ogg'
 * @returns {Promise<{text: string, duration?: number, language?: string} | null>}
 */
export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg', filenameHint = 'audio.ogg') {
  if (!OPENAI_API_KEY) {
    console.warn('[transcription] OPENAI_API_KEY ausente — skip');
    return null;
  }
  if (!audioBuffer || audioBuffer.length === 0) return null;

  // Limite OpenAI: 25MB
  if (audioBuffer.length > 24 * 1024 * 1024) {
    return { text: '[audio muito grande — nao transcrito]', _skipped: true };
  }

  try {
    const form = new FormData();
    // Filename precisa de extensao reconhecida pelo Whisper
    const ext = (mimeType.includes('opus') || mimeType.includes('ogg')) ? 'ogg'
              : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
              : mimeType.includes('wav') ? 'wav'
              : mimeType.includes('webm') ? 'webm'
              : mimeType.includes('m4a') || mimeType.includes('mp4') ? 'm4a'
              : 'ogg';
    form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');  // PT-BR — pula auto-detect e melhora qualidade
    form.append('response_format', 'verbose_json');  // pra ter duration

    const t0 = Date.now();
    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });
    const latency = Date.now() - t0;

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[transcription] erro HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const text = (data.text || '').trim();
    if (!text) return null;

    console.log(`[transcription] ${text.length} chars em ${latency}ms, duration=${data.duration || '?'}s`);
    return {
      text,
      duration: data.duration || null,
      language: data.language || 'pt',
      latency_ms: latency,
    };
  } catch (e) {
    console.error('[transcription] erro:', e.message);
    return null;
  }
}
