'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const notificationService = require('../../services/notifications.service');
const connectionStatus = require('../../services/whatsappConnectionStatus.service');

function patchProperty(object, key, value) {
  const previous = object[key];
  object[key] = value;
  return () => { object[key] = previous; };
}

function objectAccessError() {
  return {
    response: {
      status: 400,
      data: {
        error: {
          code: 100,
          error_subcode: 33,
          message: 'Object does not exist or cannot be loaded due to missing permissions',
        },
      },
    },
  };
}

test('la pérdida de acceso normaliza ambos estados y solo avisa una vez', async () => {
  let notifications = 0;
  const asset = {
    id: 374,
    clinicaId: 56,
    phoneNumberId: 'phone-1',
    wabaId: 'waba-1',
    additionalData: {
      coexistence: {
        status: 'active',
        coexistence_status: 'active',
        canSendApi: true,
        can_send_api: true,
      },
      registration: {},
    },
    async save() {},
  };
  const wabaAsset = {
    id: 373,
    additionalData: {
      coexistence: {
        status: 'active',
        coexistence_status: 'active',
        canSendApi: true,
        can_send_api: true,
      },
    },
    async save() {},
  };
  const restores = [
    patchProperty(db.ClinicMetaAsset, 'findOne', async () => asset),
    patchProperty(db.ClinicMetaAsset, 'findAll', async () => [wabaAsset]),
    patchProperty(db.Clinica, 'findByPk', async () => null),
    patchProperty(notificationService, 'dispatchEvent', async () => { notifications += 1; }),
  ];

  try {
    await connectionStatus.markDisconnectedAfterProviderError({
      error: objectAccessError(),
      clinicId: 56,
      phoneId: 'phone-1',
      wabaId: 'waba-1',
      source: 'unit_test',
    });
    await connectionStatus.markDisconnectedAfterProviderError({
      error: objectAccessError(),
      clinicId: 56,
      phoneId: 'phone-1',
      wabaId: 'waba-1',
      source: 'unit_test',
    });

    assert.equal(asset.additionalData.coexistence.status, 'disconnected');
    assert.equal(asset.additionalData.coexistence.coexistence_status, 'disconnected');
    assert.equal(asset.additionalData.coexistence.canSendApi, false);
    assert.equal(asset.additionalData.coexistence.can_send_api, false);
    assert.equal(asset.additionalData.coexistence.requiresReconnect, true);
    assert.equal(wabaAsset.additionalData.coexistence.status, 'disconnected');
    assert.equal(wabaAsset.additionalData.coexistence.coexistence_status, 'disconnected');
    assert.equal(wabaAsset.additionalData.coexistence.canSendApi, false);
    assert.equal(wabaAsset.additionalData.coexistence.can_send_api, false);
    assert.equal(wabaAsset.additionalData.coexistence.requiresReconnect, true);
    assert.equal(notifications, 1);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('la reconexión limpia una proyección antigua con coexistence_status desconectado', async () => {
  const asset = {
    id: 374,
    clinicaId: 56,
    phoneNumberId: 'phone-1',
    wabaId: 'waba-1',
    metaAssetName: '+34 600 000 000',
    additionalData: {
      coexistence: {
        status: 'active',
        coexistence_status: 'disconnected',
        canSendApi: true,
        can_send_api: false,
        requiresReconnect: false,
      },
    },
    async save() {},
  };
  const wabaAsset = {
    id: 373,
    additionalData: {
      coexistence: {
        status: 'disconnected',
        coexistence_status: 'disconnected',
        canSendApi: false,
        can_send_api: false,
        requiresReconnect: true,
        last_error_code: 100,
      },
    },
    async save() {},
  };
  const restores = [
    patchProperty(db.ClinicMetaAsset, 'findOne', async () => asset),
    patchProperty(db.ClinicMetaAsset, 'findAll', async () => [wabaAsset]),
    patchProperty(db.Notification, 'findAll', async () => []),
    patchProperty(db.Clinica, 'findByPk', async () => null),
    patchProperty(notificationService, 'dispatchEvent', async () => null),
  ];

  try {
    const result = await connectionStatus.clearDisconnectedAfterSuccess({
      clinicId: 56,
      phoneId: 'phone-1',
      wabaId: 'waba-1',
      source: 'unit_test',
    });

    assert.equal(result.cleared, true);
    assert.equal(asset.additionalData.coexistence.status, 'active');
    assert.equal(asset.additionalData.coexistence.coexistence_status, 'active');
    assert.equal(asset.additionalData.coexistence.canSendApi, true);
    assert.equal(asset.additionalData.coexistence.can_send_api, true);
    assert.equal(asset.additionalData.coexistence.requiresReconnect, false);
    assert.equal(wabaAsset.additionalData.coexistence.status, 'active');
    assert.equal(wabaAsset.additionalData.coexistence.coexistence_status, 'active');
    assert.equal(wabaAsset.additionalData.coexistence.canSendApi, true);
    assert.equal(wabaAsset.additionalData.coexistence.can_send_api, true);
    assert.equal(wabaAsset.additionalData.coexistence.requiresReconnect, false);
    assert.equal(wabaAsset.additionalData.coexistence.last_error_code, undefined);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});
