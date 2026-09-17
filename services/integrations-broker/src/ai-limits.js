'use strict';

// Dedicated AI runtime only. Existing WhatsApp/Google transports keep their limits.
const OPERATIONS = Object.freeze({
  openai: 'ai.openai.responses.create.v1',
  gemini: 'ai.gemini.interactions.create.v1',
  groq: 'ai.groq.audio.transcribe.v1',
});
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 190000;
const isAiOperation = operation => Object.values(OPERATIONS).includes(operation);
module.exports = { OPERATIONS, MAX_FILE_BYTES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_TIMEOUT_MS, isAiOperation };
