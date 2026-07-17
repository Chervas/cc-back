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
    'best_dentist',
    'recommended_local',
    'trusted_reviews',
  ]);
  assert.deepEqual(typicalQueries.map((item) => item.query), [
    '¿Cuál es la mejor clínica dental en Hospitalet?',
    '¿Cuál es el mejor dentista en Hospitalet?',
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
  const overviewWithoutSecrets = await service.getOverview(59, { autoStart: true }, {
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
  assert.equal(overviewWithoutSecrets.typical_queries.length, 4);
  assert.equal(overviewWithoutSecrets.refresh_interval_days, 7);
  assert.equal(overviewWithoutSecrets.cache_hours, 168);
  assert.equal(overviewWithoutSecrets.max_runs_per_clinic_7d, 4);
  assert.equal(overviewWithoutSecrets.max_attempts_per_query_7d, 1);
  assert.equal(overviewWithoutSecrets.runs.length, 0);

  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    const technicalRead = await service.getOverview(59, {}, {
      resolveClinicContext: async () => ({
        id: 59,
        name: 'Propdental Hospitalet',
        category: 'Clínica dental',
        city: 'Hospitalet',
        province: 'Barcelona',
      }),
      RunModel: { findAll: async () => [] },
    });
    assert.equal(technicalRead.automatic.status, 'disabled_for_request');
    assert.equal(technicalRead.automatic.triggered, false);

    assert.equal(partialRunIsReusable({
      status: 'completed_with_errors',
      created_at: new Date(),
      provider_status: {
        openai: { configured: false, status: 'not_configured' },
        gemini: { configured: true, status: 'completed' },
      },
    }), true, 'un cambio de configuración no debe saltarse el límite semanal');
    assert.equal(partialRunIsReusable({
      status: 'completed_with_errors',
      created_at: new Date(),
      provider_status: {
        openai: { configured: true, status: 'completed' },
        gemini: { configured: true, status: 'billing_required' },
      },
    }), true, 'un fallo recuperable reciente se reutiliza durante la semana');
    assert.equal(partialRunIsReusable({
      status: 'completed_with_errors',
      created_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      provider_status: {
        openai: { configured: true, status: 'completed' },
        gemini: { configured: true, status: 'billing_required' },
      },
    }), true, 'un parcial de seis días todavía se reutiliza');
    assert.equal(partialRunIsReusable({
      status: 'completed_with_errors',
      created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      provider_status: {
        openai: { configured: true, status: 'completed' },
        gemini: { configured: true, status: 'billing_required' },
      },
    }), false, 'un parcial anterior a siete días puede actualizarse al volver a Informes');

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
    assert.equal(automatic.queued, 4);
    assert.equal(createdRows.length, 4);
    assert.equal(queuedJobs.length, 4);
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

    const weeklyCompletedRow = {
      id: 100,
      clinica_id: 59,
      query: typicalQueries[0].query,
      query_hash: 'weekly-completed',
      status: 'completed',
      provider_status: { openai: { configured: true, status: 'completed' } },
      provider_results: {
        openai: {
          status: 'completed',
          text: 'Resultado semanal',
          sources: [{ title: 'Fuente', url: 'https://example.com/source' }],
          citations: [{ id: 1, title: 'Fuente', url: 'https://example.com/source' }],
        },
      },
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      created_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      updated_at: new Date(),
    };
    const reusedWeekly = await service.enqueueRun({
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
      RunModel: { findOne: async () => weeklyCompletedRow },
      jobRequestsService: {
        enqueueUniqueJobRequest: async () => {
          throw new Error('no debe encolar dentro de la ventana semanal');
        },
      },
      jobScheduler: { triggerImmediate: async () => undefined },
    });
    assert.equal(reusedWeekly.reused, true);
    assert.equal(reusedWeekly.queued, false);
    assert.equal(reusedWeekly.run.provider_results.openai.text, 'Resultado semanal');
    assert.equal(reusedWeekly.run.provider_results.openai.sources[0].url, 'https://example.com/source');

    const failedWeekly = await service.enqueueRun({
      clinicId: 59,
      clinic: {
        id: 59,
        name: 'Propdental Hospitalet',
        category: 'Clínica dental',
        city: 'Hospitalet',
      },
      typicalQueries,
      query: typicalQueries[1].query,
    }, {
      RunModel: {
        findOne: async () => ({
          ...weeklyCompletedRow,
          id: 101,
          query: typicalQueries[1].query,
          status: 'failed',
          error_summary: [{ code: 'PROVIDER_ERROR', message: 'Fallo semanal' }],
        }),
      },
      jobRequestsService: {
        enqueueUniqueJobRequest: async () => {
          throw new Error('un fallo semanal tampoco debe encolar otra ejecución');
        },
      },
      jobScheduler: { triggerImmediate: async () => undefined },
    });
    assert.equal(failedWeekly.reused, true);
    assert.equal(failedWeekly.run.status, 'failed');

    await assert.rejects(
      service.enqueueRun({
        clinicId: 59,
        clinic: {
          id: 59,
          name: 'Propdental Hospitalet',
          category: 'Clínica dental',
          city: 'Hospitalet',
        },
        typicalQueries,
        query: typicalQueries[2].query,
      }, {
        RunModel: {
          findOne: async () => null,
          count: async (options = {}) => options?.where?.query_hash ? 1 : 0,
        },
        jobRequestsService: {
          enqueueUniqueJobRequest: async () => {
            throw new Error('el rate limit semanal debe actuar antes de la cola');
          },
        },
        jobScheduler: { triggerImmediate: async () => undefined },
      }),
      (error) => error?.code === 'AI_VISIBILITY_QUERY_ATTEMPT_LIMIT'
        && /últimos siete días/.test(error.message),
    );
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
