'use strict';

// Dedicated AI runtime only. Existing WhatsApp/Google transports keep their limits.
const OPERATIONS = Object.freeze({
  openai: 'ai.openai.responses.create.v1',
  gemini: 'ai.gemini.interactions.create.v1',
  groq: 'ai.groq.audio.transcribe.v1',
});
const MODEL_CHECK_OPERATION = 'ai.groq.model.check.v1';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// File bytes travel directly from the CRM transfer service to the provider.
// Admission bounds text/metadata, provider work and response delivery.
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_PENDING_REQUEST_BYTES = MAX_REQUEST_BYTES;
const MAX_TIMEOUT_MS = 190000;
const isAiOperation = operation => operation === MODEL_CHECK_OPERATION || Object.values(OPERATIONS).includes(operation);
module.exports = { OPERATIONS, MODEL_CHECK_OPERATION, MAX_FILE_BYTES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  MAX_CONCURRENT_REQUESTS, MAX_PENDING_REQUEST_BYTES, MAX_TIMEOUT_MS, isAiOperation };
