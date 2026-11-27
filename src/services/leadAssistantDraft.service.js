'use strict';

const keys = ['tone', 'context', 'promotions', 'guardrails', 'booking'];
const promotionCharacterLimit = 120000;
const fail = (status, code) => Object.assign(new Error(code), { status, code });

function validate(input) {
  const { version, fields } = input || {};
  if (!Number.isSafeInteger(version) || version < 0 || !fields || typeof fields !== 'object' ||
      Array.isArray(fields) || Object.keys(fields).length !== keys.length ||
      !keys.every(key => typeof fields[key] === 'string' && (key === 'promotions'
        ? Array.from(fields[key]).length <= promotionCharacterLimit : fields[key].length <= 12000)) ||
      Object.keys(input).some(key => !['version', 'fields'].includes(key))) {
    throw fail(400, 'assistant_draft_invalid');
  }
}

function create(db) {
  async function clinicFor(clinicId, transaction) {
    const options = { attributes: ['id_clinica', 'nombre_clinica'], raw: true };
    if (transaction) Object.assign(options, { transaction, lock: transaction.LOCK.UPDATE });
    const clinic = await db.Clinica.findByPk(clinicId, options);
    if (!clinic) throw fail(404, 'clinic_not_found');
    return clinic;
  }
  function present(clinic, row) {
    return { promotionCharacterLimit, clinicId: clinic.id_clinica, clinicName: clinic.nombre_clinica, version: row?.version || 0,
      fields: row ? row.fields : Object.fromEntries(keys.map(key => [key, ''])) };
  }
  async function read(clinicId) {
    const clinic = await clinicFor(clinicId);
    return present(clinic, await db.LeadAssistantDraft.findByPk(clinicId));
  }
  async function save(clinicId, actorId, input) {
    validate(input);
    return db.sequelize.transaction(async transaction => {
      const clinic = await clinicFor(clinicId, transaction);
      const current = await db.LeadAssistantDraft.findByPk(clinicId, { transaction, lock: transaction.LOCK.UPDATE });
      if (input.version !== (current?.version || 0)) throw fail(409, 'assistant_draft_changed');
      const update = { version: input.version + 1, fields: input.fields, updated_by: actorId, updated_at: new Date() };
      const row = current ? await current.update(update, { transaction })
        : await db.LeadAssistantDraft.create({ clinic_id: clinicId, ...update }, { transaction });
      return present(clinic, row);
    });
  }
  return { read, save };
}
module.exports = { create };
