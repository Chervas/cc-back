'use strict';

const assert = require('assert');

const db = require('../../../models');
const service = require('../../services/marketingBulkSends.service');
const controller = require('../../controllers/marketingBulkSends.controller');
const marketingRouter = require('../../routes/marketing.routes');

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

async function main() {
  const clinicScope = {
    scope: 'clinic',
    clinicIds: [66],
    groupId: null,
    original: '66',
    isAll: false,
    isValid: true,
  };

  let loaderCalls = 0;
  const active = await service.getReviewRequestAutomationStatus(clinicScope, {
    getReviewAutomationTemplate: async (scope, options) => {
      loaderCalls += 1;
      assert.strictEqual(scope, clinicScope);
      assert.deepEqual(options, { includeInactive: true });
      return {
        id: 123,
        public_id: 'flw_review_req_clinic_66',
        template_key: 'review_request_after_completed__clinic_66',
        version: 2,
        name: 'Solicitar reseñas automáticamente',
        clinic_id: 66,
        group_id: null,
        is_system: false,
        trigger_type: 'appointment_completed',
        trigger_config: {
          event_name: 'appointment_completed',
          managed_feature: 'review_request',
          configured: true,
          configuration_version: 1,
          review_source: 'completed_treatment',
          review_delay: '24h',
          initial_delay_hours: 24,
        },
        published_at: new Date('2026-08-06T09:00:00.000Z'),
        is_active: true,
        nodes: [
          {
            id: 'N2',
            type: 'delay/fixed',
            config: { duration: 24, unit: 'hours' },
          },
          {
            id: 'N3',
            type: 'action/request_review',
            config: {
              review_source: 'completed_treatment',
              whatsapp_template_id: 462,
              review_sender_name: 'Lidia',
            },
          },
        ],
      };
    },
  });
  assert.deepEqual(active, {
    success: true,
    clinic_id: 66,
    automation_enabled: true,
    automation_configured: true,
    configuration_errors: [],
    automation_template: {
      id: 123,
      public_id: 'flw_review_req_clinic_66',
      template_key: 'review_request_after_completed__clinic_66',
      version: 2,
      name: 'Solicitar reseñas automáticamente',
      is_active: true,
      configured: true,
      configuration_errors: [],
      review_source: 'completed_treatment',
      review_delay: '24h',
      initial_delay_hours: 24,
      review_threshold: 5,
      whatsapp_template_id: 462,
      template_name: 'clinicaclick_solicitar_resena',
      review_gift_enabled: false,
      review_gift_description: null,
      review_display_clinic_name: null,
      review_sender_name: 'Lidia',
      review_team_photo_url: null,
      review_team_photo_overlay_color: '#4f46e5',
      review_team_members_text: null,
    },
  });
  assert.equal(loaderCalls, 1, 'el endpoint ligero solo debe leer la plantilla de automatización');

  const inactive = await service.getReviewRequestAutomationStatus(clinicScope, {
    getReviewAutomationTemplate: async () => ({ id: 124, is_active: false }),
  });
  assert.equal(inactive.automation_enabled, false);
  assert.equal(inactive.automation_configured, false);

  const ambiguousActive = await service.getReviewRequestAutomationStatus(clinicScope, {
    getReviewAutomationTemplate: async () => ({
      id: 125,
      clinic_id: 66,
      trigger_type: 'appointment_completed',
      published_at: new Date(),
      is_active: true,
      nodes: [{ type: 'action/request_review', config: {} }],
    }),
  });
  assert.equal(ambiguousActive.automation_enabled, false);
  assert.equal(ambiguousActive.automation_configured, false);

  const absent = await service.getReviewRequestAutomationStatus(clinicScope, {
    getReviewAutomationTemplate: async () => null,
  });
  assert.equal(absent.automation_enabled, false);

  const blockedWithoutExplicitTemplate = await service.createAndStartReviewRequestForAppointment({
    appointmentId: 999999,
    clinicId: 66,
  });
  assert.equal(blockedWithoutExplicitTemplate.sent, false);
  assert.equal(blockedWithoutExplicitTemplate.skipped, true);
  assert.equal(blockedWithoutExplicitTemplate.reason, 'review_automation_requires_explicit_configuration');

  await assert.rejects(
    service.getReviewRequestAutomationStatus({
      ...clinicScope,
      scope: 'group',
      groupId: 5,
      clinicIds: [55, 56],
      original: 'group:5',
    }, {
      getReviewAutomationTemplate: async () => {
        throw new Error('no debe consultar una identidad ambigua de grupo');
      },
    }),
    (error) => error?.code === 'REVIEW_AUTOMATION_SINGLE_CLINIC_REQUIRED'
      && error?.status === 400,
  );

  const originalStatusReader = service.getReviewRequestAutomationStatus;
  let controllerScope = null;
  try {
    service.getReviewRequestAutomationStatus = async (scope) => {
      controllerScope = scope;
      return { success: true, clinic_id: 66, automation_enabled: true };
    };
    const res = responseRecorder();
    await controller.getReviewRequestAutomationStatus({
      query: { clinicId: '66' },
      userData: { userId: 7 },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.automation_enabled, true);
    assert.equal(res.payload.scope.type, 'clinic');
    assert.deepEqual(res.payload.scope.clinicIds, [66]);
    assert.equal(controllerScope.scope, 'clinic');
    assert.deepEqual(controllerScope.clinicIds, [66]);
  } finally {
    service.getReviewRequestAutomationStatus = originalStatusReader;
  }

  const route = marketingRouter.stack.find(
    (layer) => layer.route?.path === '/review-requests/automation-status',
  );
  assert(route, 'la ruta ligera de estado debe estar registrada');
  assert.equal(route.route.methods.get, true);

  console.log('marketing_review_automation_status.test.js: OK');
}

(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }

  try {
    await db.sequelize.close();
  } catch (error) {
    console.error('No se pudo cerrar Sequelize tras la prueba:', error);
    exitCode = 1;
  }

  // Importar marketing.routes carga servicios con timers propios. La prueba
  // ya ha esperado todas sus aserciones y el cierre de DB; salir aquí evita
  // que esos handles mantengan vivo el proceso y conserva el código de fallo.
  process.exit(exitCode);
})();
