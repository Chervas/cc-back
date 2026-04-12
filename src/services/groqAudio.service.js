'use strict';

const axios = require('axios');

function cleanString(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeMimeType(value) {
  return cleanString(value).split(';')[0].trim().toLowerCase() || 'audio/ogg';
}

function extensionForMimeType(mimeType) {
  const normalized = normalizeMimeType(mimeType);
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg';
  return 'audio';
}

class GroqAudioService {
  constructor() {
    this.defaultBaseUrl = 'https://api.groq.com/openai/v1';
    this.defaultModel = 'whisper-large-v3-turbo';
  }

  isConfigured() {
    return !!cleanString(process.env.GROQ_API_KEY);
  }

  async transcribeAudioBuffer({ buffer, mimeType, fileName } = {}) {
    const apiKey = cleanString(process.env.GROQ_API_KEY);
    if (!apiKey) {
      throw new Error('groq_api_key_missing');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('audio_buffer_empty');
    }
    if (typeof FormData !== 'function' || typeof Blob !== 'function') {
      throw new Error('node_formdata_blob_unavailable');
    }

    const baseUrl = (cleanString(process.env.GROQ_API_BASE_URL) || this.defaultBaseUrl).replace(/\/+$/, '');
    const model = cleanString(process.env.GROQ_STT_MODEL) || this.defaultModel;
    const timeout = parsePositiveInt(
      process.env.GROQ_STT_TIMEOUT_MS || process.env.GROQ_TIMEOUT_MS,
      30000
    );
    const normalizedMimeType = normalizeMimeType(mimeType);
    const normalizedFileName =
      cleanString(fileName) || `whatsapp-audio.${extensionForMimeType(normalizedMimeType)}`;

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: normalizedMimeType }), normalizedFileName);
    form.append('model', model);
    form.append('response_format', 'json');

    const response = await axios.post(`${baseUrl}/audio/transcriptions`, form, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      timeout,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const data = response?.data || {};
    const text = cleanString(data.text || data.transcription || data.output_text);
    if (!text) {
      throw new Error('groq_audio_transcription_empty');
    }

    return {
      provider: 'groq',
      model,
      text,
    };
  }
}

module.exports = new GroqAudioService();
