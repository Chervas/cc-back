'use strict';

// Installed only in the prepared trial copy. Reuse the original transport,
// credentials, endpoint pinning, response limits and error handling for both models.
const original = require('./bedrock-http-original');
const contract = require('./bedrock-contract');
const Ajv = require('ajv');
const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');

const STOP_REASONS = new Set(['tool_use', 'end_turn', 'max_tokens', 'stop_sequence',
  'guardrail_intervened', 'content_filtered', 'malformed_model_output',
  'malformed_tool_use', 'model_context_window_exceeded', 'refusal']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function projectTrial(response, validateInput, credentialValues) {
  const errors = [];
  const reject = code => { if (!errors.includes(code)) errors.push(code); };
  const source = record(response) ? response : {};
  const message = source.output?.message;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  if (!record(response) || !record(message) || message.role !== 'assistant'
    || !Array.isArray(message.content)) reject('invalid_response_structure');
  for (const block of blocks) {
    if (!record(block) || Object.keys(block).length !== 1
      || !(Object.hasOwn(block, 'toolUse')
        || Object.hasOwn(block, 'text') && typeof block.text === 'string'
        || Object.hasOwn(block, 'reasoningContent') && record(block.reasoningContent))) {
      reject('invalid_response_structure');
    }
  }
  // Count every tool block before the original projection can discard extras.
  const tools = blocks.filter(block => record(block) && Object.hasOwn(block, 'toolUse'));
  if (tools.length === 0) reject('tool_use_missing');
  if (tools.length > 1) reject('tool_use_multiple');
  if (source.stopReason !== 'tool_use') reject('invalid_stop_reason');
  if (tools.length === 1) {
    const tool = tools[0].toolUse;
    if (!record(tool) || typeof tool.toolUseId !== 'string' || !tool.toolUseId.trim()
      || !record(tool.input)) reject('invalid_tool_use');
    if (tool?.name !== 'submit_analysis') reject('unexpected_tool_name');
    if (record(tool?.input) && !validateInput(tool.input)) reject('output_schema_invalid');
  }

  // Project only known metadata and valid tool input. Never return provider text,
  // reasoning, schema paths, offending values, or arbitrary stop reason strings.
  const requestId = source.$metadata?.requestId;
  const data = original.project({
    output: { message: { content: errors.length ? [] : tools } },
    usage: source.usage,
    metrics: source.metrics,
    stopReason: STOP_REASONS.has(source.stopReason) ? source.stopReason : '',
    $metadata: { requestId: typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(requestId) ? requestId : '' },
  });
  const serialized = JSON.stringify(data);
  if (credentialValues.some(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]
    .some(part => serialized.includes(part)))) {
    reject('credential_reflection');
    data.output.message.content = [];
    data.$metadata.requestId = '';
  }
  data.trialValidation = { version: 1, valid: errors.length === 0, errors, toolUseCount: tools.length };
  return data;
}

function createBedrockHttp(options = {}) {
  const novaHttp = original.createBedrockHttp(options);
  const clientFactory = options.clientFactory || (config => new BedrockRuntimeClient(config));
  return async args => {
    if (args.payload?.body?.modelId !== contract.MODEL) return novaHttp(args);
    contract.validate(args.payload);
    const validateInput = new Ajv({ strict: true, ownProperties: true }).compile(
      args.payload.body.toolConfig.tools[0].toolSpec.inputSchema.json);
    // Per-request state: concurrent evaluations cannot exchange validation results.
    let trialValidation;
    const sonnetHttp = original.createBedrockHttp({
      ...options,
      clientFactory: config => {
        const credentialValues = Object.values(config.credentials).filter(value => typeof value === 'string');
        const client = clientFactory({ ...config, maxAttempts: 1 });
        return {
          async send(command, sendOptions) {
            const response = await client.send(command, sendOptions);
            const data = projectTrial(response, validateInput, credentialValues);
            trialValidation = data.trialValidation;
            return data;
          },
          destroy() { client.destroy?.(); },
        };
      },
    });
    const data = await sonnetHttp(args);
    return { ...data, trialValidation };
  };
}

module.exports = { ...original, createBedrockHttp };
