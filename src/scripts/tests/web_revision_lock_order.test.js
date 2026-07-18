'use strict';

process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';

const assert = require('node:assert/strict');
const { transitionRevision } = require('../../services/webProjects.service');

function row(values) {
  return {
    ...values,
    get() { return { ...this }; },
  };
}

async function main() {
  const calls = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const project = row({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
  });
  const revision = row({
    id: '22222222-2222-4222-8222-222222222222',
    projectId: project.id,
    revisionNumber: 1,
    status: 'draft',
    documentHash: 'a'.repeat(64),
    save: async function save(options) {
      calls.push(['revision-save', Boolean(options.lock)]);
    },
  });
  let revisionReads = 0;
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66 }) },
    GrupoClinica: {},
    WebProject: {
      findByPk: async (_id, options) => {
        calls.push(['project-read', options.lock]);
        return project;
      },
    },
    WebRevision: {
      findByPk: async (_id, options) => {
        revisionReads += 1;
        calls.push([revisionReads === 1 ? 'revision-pointer' : 'revision-read', options.lock || null]);
        return revision;
      },
    },
    WebAuditEvent: { create: async () => calls.push(['audit']) },
  };
  const sequelize = { transaction: async (callback) => callback(transaction) };
  const result = await transitionRevision({
    actorId: 1,
    revisionId: revision.id,
    action: 'submit',
    models,
    sequelize,
  });
  assert.deepEqual(calls.slice(0, 3), [
    ['revision-pointer', null],
    ['project-read', 'UPDATE'],
    ['revision-read', 'UPDATE'],
  ]);
  assert.equal(result.status, 'review');
  console.log('web revision lock order: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
