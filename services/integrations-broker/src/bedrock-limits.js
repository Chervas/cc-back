'use strict';
// Text automation has its own service, signing identity and admission pool.
// It never shares occupied HTTP slots with OCR/audio in ai-main.
const OPERATION = 'ai.bedrock.converse.v1';
const USE_CASES = Object.freeze(['automation_v2_analysis', 'classify_intent', 'confirm_appointment', 'custom',
  'review_response_classification', 'review_response_classifier', 'extract_data', 'summarize_conversation', 'health_check']);
const REGION = 'eu-south-2';
const MODELS = Object.freeze(['eu.amazon.nova-micro-v1:0', 'eu.amazon.nova-lite-v1:0', 'eu.amazon.nova-pro-v1:0']);
const MAX_TIMEOUT_MS = 120000;
module.exports = { OPERATION, USE_CASES, REGION, MODELS, MAX_TIMEOUT_MS };
