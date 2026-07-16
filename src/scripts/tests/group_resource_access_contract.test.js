#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../../../models');
const { queues } = require('../../services/queue.service');
const groupAssetsService = require('../../services/groupAssets.service');
const controller = require('../../controllers/gruposclinicas.controller');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

async function main() {
  const originals = {
    clinicFindAll: db.Clinica.findAll,
    membershipFindAll: db.UsuarioClinica.findAll,
    groupFindByPk: db.GrupoClinica.findByPk,
    getGroupConfig: groupAssetsService.getGroupConfig,
    updateGroupConfig: groupAssetsService.updateGroupConfig,
  };

  let configReads = 0;
  let configWrites = 0;
  let groupDestroyed = false;

  db.Clinica.findAll = async (options = {}) => {
    if (options.where?.grupoClinicaId === 5) return [{ id_clinica: 56 }, { id_clinica: 58 }];
    return [];
  };
  db.UsuarioClinica.findAll = async (options = {}) => {
    const actorId = Number(options.where?.id_usuario);
    const clinicIds = options.where?.id_clinica?.[Op.in] || [];
    const allowedRoles = options.where?.rol_clinica?.[Op.in] || [];
    if (!clinicIds.some((id) => [56, 58].includes(id))) return [];
    if (actorId === 9001 && allowedRoles.includes('agencia')) {
      return [{ id_clinica: 56, rol_clinica: 'agencia' }];
    }
    if (actorId === 9004 && allowedRoles.includes('agencia')) {
      return [
        { id_clinica: 56, rol_clinica: 'agencia' },
        { id_clinica: 58, rol_clinica: 'agencia' },
      ].filter((row) => clinicIds.includes(row.id_clinica));
    }
    if (actorId === 9003 && allowedRoles.includes('propietario')) {
      return [
        { id_clinica: 56, rol_clinica: 'propietario' },
        { id_clinica: 58, rol_clinica: 'propietario' },
      ].filter((row) => clinicIds.includes(row.id_clinica));
    }
    if (actorId === 9005 && allowedRoles.includes('propietario')) {
      return [{ id_clinica: 56, rol_clinica: 'propietario' }];
    }
    return [];
  };
  db.GrupoClinica.findByPk = async (groupId) => Number(groupId) === 5
    ? {
        id_grupo: 5,
        async destroy() { groupDestroyed = true; },
      }
    : null;
  groupAssetsService.getGroupConfig = async () => {
    configReads += 1;
    return { id: 5 };
  };
  groupAssetsService.updateGroupConfig = async () => {
    configWrites += 1;
    return { id: 5 };
  };

  try {
    const darioOutside = await controller.__groupResourceAccessContract.resolveGroupResourceAccess(9002, 5);
    assert.equal(darioOutside.read, false, 'Darío outside the group must not read it');
    assert.equal(darioOutside.marketingWrite, false, 'outside agency must not gain Marketing write');

    const assignedAgency = await controller.__groupResourceAccessContract.resolveGroupResourceAccess(9001, 5);
    assert.equal(assignedAgency.read, true);
    assert.equal(assignedAgency.marketingWrite, false,
      'agency assigned to only one clinic must not mutate the whole mixed group');
    assert.equal(assignedAgency.ownerWrite, false);

    const fullyAssignedAgency = await controller.__groupResourceAccessContract.resolveGroupResourceAccess(9004, 5);
    assert.equal(fullyAssignedAgency.marketingWrite, true);

    let res = responseRecorder();
    await controller.getAdsConfig({ params: { id: '5' }, userData: { userId: 9002 } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'group_scope_forbidden');
    assert.equal(configReads, 0, 'out-of-scope config must not be loaded');

    res = responseRecorder();
    await controller.updateGroup({
      params: { id: '5' },
      userData: { userId: 9002 },
      body: { adsAccounts: { google: { mode: 'clinic' } } },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(configWrites, 0, 'out-of-scope agency must not mutate group Ads');

    res = responseRecorder();
    await controller.updateGroup({
      params: { id: '5' },
      userData: { userId: 9001 },
      body: { adsAccounts: { google: { mode: 'clinic' } } },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(configWrites, 0, 'single-clinic agency must not mutate mixed-group Ads');

    res = responseRecorder();
    await controller.updateGroup({
      params: { id: '5' },
      userData: { userId: 9004 },
      body: { nombre_grupo: 'No permitido para agencia' },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(configWrites, 0, 'agency must not mutate group administration');

    res = responseRecorder();
    await controller.updateGroup({
      params: { id: '5' },
      userData: { userId: 9004 },
      body: { adsAccounts: { google: { mode: 'clinic' } } },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(configWrites, 1, 'assigned agency may mutate scoped Ads mapping');

    res = responseRecorder();
    await controller.deleteGroup({ params: { id: '5' }, userData: { userId: 9001 } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(groupDestroyed, false, 'agency must never delete a group');

    res = responseRecorder();
    await controller.deleteGroup({ params: { id: '5' }, userData: { userId: 9005 } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(groupDestroyed, false, 'owner of only one clinic must not delete a mixed group');

    res = responseRecorder();
    await controller.deleteGroup({ params: { id: '5' }, userData: { userId: 9003 } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(groupDestroyed, true, 'scoped owner may delete the group');

    console.log('group resource access contract: ok');
  } finally {
    db.Clinica.findAll = originals.clinicFindAll;
    db.UsuarioClinica.findAll = originals.membershipFindAll;
    db.GrupoClinica.findByPk = originals.groupFindByPk;
    groupAssetsService.getGroupConfig = originals.getGroupConfig;
    groupAssetsService.updateGroupConfig = originals.updateGroupConfig;
  }
}

async function closeTestResources() {
  await Promise.all(Object.values(queues || {}).map((queue) => queue.close()));
  await db.sequelize.close();
}

main()
  .then(closeTestResources)
  .catch(async (error) => {
    console.error(error);
    await closeTestResources().catch(() => {});
    process.exitCode = 1;
  });
