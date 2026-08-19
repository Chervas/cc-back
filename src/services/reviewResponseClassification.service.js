'use strict';

const axios = require('axios');

const ALLOWED_INTENTS = new Set([
  'rating',
  'marketing_opt_out',
  'wrong_recipient',
  'review_refusal',
  'ambiguous',
]);

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalized(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function parseRating(text) {
  const raw = clean(text);
  if (!raw) return null;
  const stars = (raw.match(/[⭐★]/g) || []).length;
  if (stars >= 1 && stars <= 5 && !/\d/.test(raw)) return stars;
  const explicit = raw.match(/(?:^|[^\d])([1-5])\s*(?:\/\s*5|de\s*5|estrellas?|stars?|⭐|★)(?:$|[^\d])/i);
  if (explicit) return Number(explicit[1]);
  const contextual = raw.match(/(?:os\s+)?(?:doy|damos|pongo|ponemos|valoro|valoramos|puntuo|puntúo|califico|calificamos|mi\s+nota\s+es|nota|valoracion|valoración)\s+(?:con\s+|un\s+|una\s+|de\s+)?([1-5])(?:$|[^\d])/i);
  if (contextual) return Number(contextual[1]);
  if (raw.length <= 40) {
    const compact = raw.match(/(?:^|[^\d])([1-5])(?:$|[^\d])/);
    if (compact) return Number(compact[1]);
  }
  return null;
}

function classifyDeterministically(text, explicitRating = null) {
  const raw = clean(text);
  const value = normalized(raw);
  const rating = Number(explicitRating || 0) || parseRating(raw);
  if (!value) return { intent: 'ambiguous', rating: null, confidence: 1, source: 'rule_empty' };

  const wrongRecipient = [
    /numero (?:equivocado|incorrecto|erroneo)/,
    /no (?:soy|es) (?:esa|ese|la|el) (?:persona|paciente)/,
    /no conozco a/,
    /no he (?:ido|estado|visitado)/,
    /nunca he (?:ido|estado|visitado)/,
    /cambio de (?:dueno|propietario|titular)/,
    /ha cambiado de (?:dueno|propietario|titular)/,
    /ya no (?:pertenece|corresponde) a/,
  ].some((pattern) => pattern.test(value));
  if (wrongRecipient) {
    return { intent: 'wrong_recipient', rating: null, confidence: 0.99, source: 'rule' };
  }

  const marketingOptOut = [
    /\bbaja\b/,
    /\bstop\b/,
    /no (?:quiero|deseo) (?:recibir )?(?:mas )?(?:mensajes|whatsapp|comunicaciones|publicidad)/,
    /no me (?:escribais|escriban|mandeis|manden) (?:mas|publicidad|mensajes)/,
    /borr(?:a|ad|en) mi (?:telefono|numero)/,
    /elimin(?:a|ad|en) mi (?:telefono|numero|contacto)/,
    /no uso whatsapp para (?:empresas|publicidad)/,
    /dejad de (?:escribirme|contactarme|enviarme)/,
  ].some((pattern) => pattern.test(value));
  if (marketingOptOut) {
    return { intent: 'marketing_opt_out', rating: null, confidence: 0.99, source: 'rule' };
  }

  const reviewRefusal = [
    /no (?:quiero|deseo|voy a) (?:valorar|opinar|responder)/,
    /no (?:quiero|deseo|voy a) (?:poner|dejar|escribir) (?:una )?resena/,
    /no voy a (?:dejar|escribir) (?:una )?resena/,
    /prefiero no (?:valorar|opinar|responder|dejar|escribir)/,
  ].some((pattern) => pattern.test(value));
  if (reviewRefusal) {
    return { intent: 'review_refusal', rating: null, confidence: 0.98, source: 'rule' };
  }
  if (rating >= 1 && rating <= 5) {
    return { intent: 'rating', rating, confidence: 1, source: 'rule' };
  }
  return { intent: 'ambiguous', rating: null, confidence: 0, source: 'rule_none' };
}

function parseJson(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_ignored) {
      return null;
    }
  }
}

async function classifyWithAi(text) {
  const apiKey = clean(process.env.GROQ_API_KEY);
  if (!apiKey) return { intent: 'ambiguous', rating: null, confidence: 0, source: 'ai_unavailable' };
  const baseUrl = (clean(process.env.GROQ_API_BASE_URL) || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const model = clean(process.env.GROQ_MODEL_FAST) || 'groq/compound-mini';
  try {
    const response = await axios.post(`${baseUrl}/chat/completions`, {
      model,
      temperature: 0,
      max_tokens: 180,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Clasifica una respuesta a una solicitud de reseña clínica.',
            'Devuelve solo JSON con intent, rating, confidence y reason.',
            'intent solo puede ser rating, marketing_opt_out, wrong_recipient, review_refusal o ambiguous.',
            'rating es un entero 1-5 solo si el paciente expresa una valoración inequívoca.',
            'marketing_opt_out significa que no quiere más comunicaciones comerciales.',
            'wrong_recipient significa número erróneo, nuevo titular o que no es el paciente.',
            'review_refusal rechaza esta reseña, sin pedir necesariamente la baja general.',
            'Usa ambiguous si no hay certeza suficiente.',
          ].join(' '),
        },
        { role: 'user', content: clean(text).slice(0, 1200) },
      ],
    }, {
      timeout: Math.max(1000, Number(process.env.GROQ_TIMEOUT_MS || 12000)),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    const parsed = parseJson(response?.data?.choices?.[0]?.message?.content) || {};
    const intent = ALLOWED_INTENTS.has(clean(parsed.intent)) ? clean(parsed.intent) : 'ambiguous';
    const rating = Number(parsed.rating || 0);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
    if (confidence < 0.78) {
      return { intent: 'ambiguous', rating: null, confidence, reason: clean(parsed.reason), source: 'ai' };
    }
    return {
      intent,
      rating: intent === 'rating' && rating >= 1 && rating <= 5 ? rating : null,
      confidence,
      reason: clean(parsed.reason),
      source: 'ai',
      model: clean(response?.data?.model) || model,
    };
  } catch (error) {
    console.warn('[review-response-classification] AI classification failed', {
      error: error?.response?.data?.error?.message || error?.message || error,
    });
    return { intent: 'ambiguous', rating: null, confidence: 0, source: 'ai_error' };
  }
}

async function classifyReviewResponse({ text, explicitRating = null, allowAi = true } = {}) {
  const deterministic = classifyDeterministically(text, explicitRating);
  if (deterministic.intent !== 'ambiguous' || !allowAi || !clean(text)) return deterministic;
  return classifyWithAi(text);
}

module.exports = {
  classifyDeterministically,
  classifyReviewResponse,
  parseRating,
};
