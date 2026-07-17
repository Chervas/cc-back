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
      return { id: 123, is_active: true };
    },
  });
  assert.deepEqual(active, {
    success: true,
    clinic_id: 66,
    automation_enabled: true,
  });
  assert.equal(loaderCalls, 1, 'el endpoint ligero solo debe leer la plantilla de automatización');

  const inactive = await service.getReviewRequestAutomationStatus(clinicScope, {
    getReviewAutomationTemplate: async () => ({ id: 124, is_active: false }),
  });
  assert.equal(inactive.automation_enabled, false);

  const absent = await service.getReviewRequestAutomationStatus(clinicScope, {
    getReviewAutomationTemplate: async () => null,
  });
  assert.equal(absent.automation_enabled, false);

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
