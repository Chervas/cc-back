'use strict';

const assert = require('assert');

const service = require('../../services/marketingAiVisibility.service');
const db = require('../../../models');

const {
  buildProviderPrompt,
  normalizeQuery,
  parseGeminiResponse,
  parseOpenAiResponse,
  runGeminiSearch,
  runOpenAiSearch,
} = service.__testing;

async function main() {
  const openai = parseOpenAiResponse({
    model: 'gpt-test',
    output: [
      {
        type: 'web_search_call',
        action: {
          type: 'search',
          queries: ['mejor clínica dental Hospitalet'],
          sources: [{ title: 'Fuente extra', url: 'https://example.com/extra' }],
        },
      },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'Respuesta con fuente.',
          annotations: [{
            type: 'url_citation',
            title: 'Fuente principal',
            url: 'https://example.com/main',
            start_index: 0,
            end_index: 9,
          }],
        }],
      },
    ],
  });
  assert.equal(openai.text, 'Respuesta con fuente.');
  assert.equal(openai.queries[0], 'mejor clínica dental Hospitalet');
  assert.equal(openai.citations.length, 1);
  assert.equal(openai.citations[0].start_index, 0);
  assert.equal(openai.sources.length, 2);

  const gemini = parseGeminiResponse({
    steps: [
      { type: 'google_search_call', arguments: { queries: ['dentista Hospitalet'] } },
      { type: 'google_search_result', result: [{ search_suggestions: '<a href="https://google.com/search?q=dentista">dentista</a>' }] },
      {
        type: 'model_output',
        content: [{
          type: 'text',
          text: 'Resultado Gemini.',
          annotations: [{
            type: 'url_citation',
            title: 'Resultado local',
            url: 'https://example.org/local',
            start_index: 0,
            end_index: 9,
          }],
        }],
      },
    ],
  });
  assert.equal(gemini.text, 'Resultado Gemini.');
  assert.deepEqual(gemini.queries, ['dentista Hospitalet']);
  assert.equal(gemini.search_suggestions_html.length, 1);
  assert.equal(gemini.citations.length, 1);

  const geminiObjectResult = parseGeminiResponse({
    steps: [{
      type: 'google_search_result',
      result: { search_suggestions: '<div>resultado único</div>' },
    }],
  });
  assert.deepEqual(geminiObjectResult.search_suggestions_html, ['<div>resultado único</div>']);

  assert.equal(normalizeQuery('  mejor clínica dental en Hospitalet  '), 'mejor clínica dental en Hospitalet');
  assert.throws(() => normalizeQuery('contacta paciente@example.com'), /correos de pacientes/);
  assert.throws(() => normalizeQuery('llama al 612 345 678 para cita'), /teléfonos/);

  const prompt = buildProviderPrompt('mejor clínica dental en Hospitalet', {
    name: 'Propdental Hospitalet',
    category: 'Dentista',
    address: 'L’Hospitalet de Llobregat',
    website: 'https://example.com/',
  });
  assert.match(prompt, /No des por hecho/);
  assert.match(prompt, /datos de pacientes/);

  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    let openAiRequest = null;
    const openAiResult = await runOpenAiSearch({
      query: 'mejor clínica dental en Hospitalet',
      clinic: { name: 'Propdental Hospitalet', city: 'Hospitalet', province: 'Barcelona' },
    }, {
      axios: {
        post: async (url, body, options) => {
          openAiRequest = { url, body, options };
          return {
            data: {
              model: 'gpt-test',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'Respuesta', annotations: [] }] }],
            },
          };
        },
      },
    });
    assert.equal(openAiResult.status, 'completed');
    assert.equal(openAiRequest.body.store, false);
    assert.equal(openAiRequest.body.tools[0].type, 'web_search');
    assert.equal(openAiRequest.body.tool_choice, 'required');

    let geminiRequest = null;
    const geminiResult = await runGeminiSearch({
      query: 'mejor clínica dental en Hospitalet',
      clinic: { name: 'Propdental Hospitalet' },
    }, {
      axios: {
        post: async (url, body, options) => {
          geminiRequest = { url, body, options };
          return {
            data: {
              model: 'gemini-test',
              steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Respuesta Gemini', annotations: [] }] }],
            },
          };
        },
      },
    });
    assert.equal(geminiResult.status, 'completed');
    assert.equal(geminiRequest.body.store, false);
    assert.equal(geminiRequest.body.tools[0].type, 'google_search');
  } finally {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }

  console.log('marketing_ai_visibility.test.js: OK');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close().catch(() => undefined);
  });
