'use strict';

// Evaluation overlay only. Never installed by the application or normal broker
// release. The original Nova contract remains authoritative for every other call.
const original = require('./bedrock-contract-original');
const { fail } = require('./errors');
const MODEL = 'eu.anthropic.claude-sonnet-5-5';
const PRINCIPAL = 'bedrock:reviews-sonnet-eval-20261103';
const PURPOSE = 'google_review_reply_draft';
const bindingSchema = structuredClone(original.bindingSchema);
bindingSchema.properties.models.maxItems = 4;
bindingSchema.properties.models.items.enum.push(MODEL);

function validate(value) {
  if (value?.body?.modelId !== MODEL) return original.validate(value);
  const body = value.body;
  if (value.useCase !== PURPOSE
    || Object.keys(body.inferenceConfig || {}).join(',') !== 'maxTokens'
    || !Number.isInteger(body.inferenceConfig.maxTokens)
    || body.inferenceConfig.maxTokens < 32 || body.inferenceConfig.maxTokens > 1200
    || JSON.stringify(body.toolConfig?.toolChoice) !== '{"auto":{}}'
    || JSON.stringify(body.additionalModelRequestFields) !== '{"thinking":{"type":"between_tools"}}') fail('invalid_request');
  // Validate unchanged text/tool-schema limits with the original validator.
  // Only this copy is normalized; the native Sonnet request goes to the SDK.
  const normalized = structuredClone(value);
  normalized.body.modelId = 'eu.amazon.nova-lite-v1:0';
  normalized.body.inferenceConfig.temperature = 0;
  normalized.body.toolConfig.toolChoice = { tool: { name: 'submit_analysis' } };
  delete normalized.body.additionalModelRequestFields;
  original.validate(normalized);
  return value;
}

function authorize(context) {
  const { request, binding, principal } = context;
  const sonnet = request.payload.body.modelId === MODEL;
  if (principal?.id === PRINCIPAL && !sonnet) fail('scope_denied');
  if (sonnet && (principal?.id !== PRINCIPAL
    || request.tenantRef !== 'platform:staging'
    || request.connectionRef !== 'bedrock:staging'
    || request.payload.useCase !== PURPOSE
    || request.assetRef !== 'ai:' + PURPOSE)) fail('scope_denied');
  return original.authorize({ request, binding });
}

module.exports = { ...original, bindingSchema, validate, authorize, MODEL, PRINCIPAL };
