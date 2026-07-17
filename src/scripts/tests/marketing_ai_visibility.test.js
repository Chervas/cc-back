'use strict';

const assert = require('assert');

const service = require('../../services/marketingAiVisibility.service');
const db = require('../../../models');

const {
  buildProviderPrompt,
  buildTypicalQueries,
  findTypicalQuery,
  normalizeQuery,
  partialRunIsReusable,
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
  assert.match(prompt, /referencia de comparación/);
  assert.match(prompt, /no la introduzcas/);
  assert.match(prompt, /datos de pacientes/);

  const typicalQueries = buildTypicalQueries({
    category: 'Clínica dental',
    city: 'Hospitalet',
  });
  assert.deepEqual(typicalQueries.map((item) => item.key), [
    'best_local',
    'recommended_local',
    'trusted_reviews',
  ]);
  assert.deepEqual(typicalQueries.map((item) => item.query), [
    '¿Cuál es la mejor clínica dental en Hospitalet?',
    '¿Qué clínica dental recomiendan en Hospitalet?',
    '¿Qué clínica dental tiene buenas reseñas en Hospitalet?',
  ]);
  assert.equal(
    findTypicalQuery({ category: 'Clínica dental', city: 'Hospitalet' }, { queryKey: 'recommended_local' }).key,
    'recommended_local',
  );
  assert.equal(
    findTypicalQuery(
      { category: 'Clínica dental', city: 'Hospitalet' },
      { legacyQuery: 'texto libre que no pertenece al catálogo' },
    ).key,
    'best_local',
  );

  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const overviewWithoutSecrets = await service.getOverview(59, {}, {
    resolveClinicContext: async () => ({
      id: 59,
      name: 'Propdental Hospitalet',
      category: 'Clínica dental',
      city: 'Hospitalet',
      province: 'Barcelona',
    }),
    RunModel: {
      findAll: async () => [],
    },
  });
  assert.equal(overviewWithoutSecrets.success, true);
  assert.equal(overviewWithoutSecrets.status, 'configuration_required');
  assert.equal(overviewWithoutSecrets.automatic.status, 'waiting_configuration');
  assert.equal(overviewWithoutSecrets.typical_queries.length, 3);
  assert.equal(overviewWithoutSecrets.runs.length, 0);

  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    assert.equal(partialRunIsReusable({
      status: 'completed_with_errors',
      created_at: new Date(),
      provider_status: {
        openai: { configured: false, status: 'not_configured' },
        gemini: { configured: true, status: 'completed' },
      },
    }), false, 'un cambio de configuración debe invalidar el parcial inmediatamente');
    assert.equal(partialRunIsReusable({
      status: 'completed_with_errors',
      created_at: new Date(),
      provider_status: {
        openai: { configured: true, status: 'completed' },
        gemini: { configured: true, status: 'billing_required' },
      },
    }), true, 'un fallo recuperable reciente respeta el cooldown');
    assert.equal(partialRunIsReusable({
      status: 'completed_with_errors',
      created_at: new Date(Date.now() - 61 * 60 * 1000),
      provider_status: {
        openai: { configured: true, status: 'completed' },
        gemini: { configured: true, status: 'billing_required' },
      },
    }), false, 'un parcial recuperable se puede reintentar tras el cooldown');

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

    let nextRunId = 0;
    let nextJobId = 0;
    const createdRows = [];
    const queuedJobs = [];
    const RunModel = {
      findOne: async () => null,
      count: async (options = {}) => {
        const queryHash = options?.where?.query_hash;
        if (queryHash) return createdRows.filter((row) => row.query_hash === queryHash).length;
        if (options.distinct && options.col === 'query_hash') {
          return new Set(createdRows.map((row) => row.query_hash)).size;
        }
        return createdRows.length;
      },
      create: async (values) => {
        const row = {
          id: ++nextRunId,
          ...values,
          created_at: new Date(),
          updated_at: new Date(),
          update: async (changes) => {
            Object.assign(row, changes, { updated_at: new Date() });
            return row;
          },
        };
        createdRows.push(row);
        return row;
      },
      findByPk: async (id) => createdRows.find((row) => row.id === Number(id)) || null,
    };
    const automatic = await service.ensureTypicalRuns({
      clinicId: 59,
      clinic: {
        id: 59,
        name: 'Propdental Hospitalet',
        category: 'Clínica dental',
        city: 'Hospitalet',
        province: 'Barcelona',
      },
      typicalQueries,
      requestedBy: 7,
    }, {
      RunModel,
      jobRequestsService: {
        enqueueUniqueJobRequest: async (input) => {
          queuedJobs.push(input);
          return {
            created: true,
            job: { id: ++nextJobId, payload: input.payload },
          };
        },
      },
      jobScheduler: { triggerImmediate: async () => undefined },
    });
    assert.equal(automatic.status, 'queued');
    assert.equal(automatic.triggered, true);
    assert.equal(automatic.queued, 3);
    assert.equal(createdRows.length, 3);
    assert.equal(queuedJobs.length, 3);
    assert(queuedJobs.every((job) => job.origin === 'marketing_reports:ai_visibility_automatic'));
    assert(queuedJobs.every((job) => /^ai_visibility:59:/.test(job.dedupeScope)));

    let unexpectedCreate = false;
    let unexpectedJob = false;
    const activeRow = {
      id: 99,
      clinica_id: 59,
      query: typicalQueries[0].query,
      query_hash: 'active',
      status: 'queued',
      provider_status: {},
      expires_at: new Date(Date.now() + 60000),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const reusedActive = await service.enqueueRun({
      clinicId: 59,
      clinic: {
        id: 59,
        name: 'Propdental Hospitalet',
        category: 'Clínica dental',
        city: 'Hospitalet',
      },
      typicalQueries,
      query: typicalQueries[0].query,
    }, {
      RunModel: {
        findOne: async () => activeRow,
        create: async () => {
          unexpectedCreate = true;
          throw new Error('unexpected create');
        },
      },
      jobRequestsService: {
        enqueueUniqueJobRequest: async () => {
          unexpectedJob = true;
          throw new Error('unexpected job');
        },
      },
      jobScheduler: { triggerImmediate: async () => undefined },
    });
    assert.equal(reusedActive.reused, true);
    assert.equal(reusedActive.queued, true);
    assert.equal(reusedActive.run.query_key, 'best_local');
    assert.equal(unexpectedCreate, false);
    assert.equal(unexpectedJob, false);
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
