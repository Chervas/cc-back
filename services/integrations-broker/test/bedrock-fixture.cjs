'use strict';
const { MODELS } = require('../src/bedrock-limits');
const credentials = { accessKeyId: 'AKIAFICTITIOUSONLY123', secretAccessKey: 'FICTITIOUS_ONLY_SECRET_01234567890123456789' };
function payload() {
  return { useCase: 'confirm_appointment', timeoutMs: 20000, body: {
    modelId: MODELS[0], system: [{ text: 'FICTITIOUS_SYSTEM' }],
    messages: [{ role: 'user', content: [{ text: 'FICTITIOUS_CONVERSATION: Sí, confirmo. 日本語 👍' }] }],
    inferenceConfig: { maxTokens: 700, temperature: 0 },
    toolConfig: { tools: [{ toolSpec: { name: 'submit_analysis', description: 'Devuelve el resultado estructurado del análisis solicitado.',
      inputSchema: { json: { type: 'object', properties: { confirmado: { type: 'boolean' }, motivo: { type: 'string' } },
        required: ['confirmado', 'motivo'], additionalProperties: false } } } }], toolChoice: { tool: { name: 'submit_analysis' } } },
  } };
}
function response() {
  return { output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'fictitious', name: 'submit_analysis',
    input: { confirmado: true, motivo: 'FICTITIOUS_OUTPUT' } } }] } }, usage: { inputTokens: 42, outputTokens: 12, totalTokens: 54 },
    metrics: { latencyMs: 8 }, stopReason: 'tool_use', $metadata: { requestId: 'fictitious-request' } };
}
module.exports = { payload, response, credentials };
