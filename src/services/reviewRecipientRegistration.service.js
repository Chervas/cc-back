'use strict';

const { captureRecipientRegistration, applyRecipientRegistration } = require('../lib/recipient-list-registration');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const fail = (message, status = 409) => Object.assign(Error(message), { status });
function projection(snapshot) {
  const names = new Map(snapshot.rows.map(row => [Number(row.id), row.name]));
  const plan = snapshot.plan;
  return { success: true, clinicId: plan.clinicId, listId: plan.listId, sha256: plan.sha256,
    counts: plan.counts, total: plan.operations.length,
    needsRegistration: plan.operations.some(op => ['create','link','review'].includes(op.action)),
    review: plan.operations.filter(op => op.action === 'review').slice(0, 50).map(op => ({ itemId: op.itemId, name: names.get(op.itemId), reason: op.reason })),
    reviewTotal: plan.operations.filter(op => op.action === 'review').length };
}
async function run({ db, clinicId, listId, actorId, expectedSha256, sourceSystem, apply = false }) {
  if (![clinicId,listId,actorId].every(n => Number.isSafeInteger(n) && n > 0)) throw fail('Clínica o listado inválidos', 400);
  if (apply && (!/^[a-f0-9]{64}$/.test(expectedSha256 || '') || !['gesden','cliniccloud','other','unknown'].includes(sourceSystem))) throw fail('Revisa la previsualización y el origen del listado', 400);
  const raw = await db.sequelize.connectionManager.getConnection();
  const connection = raw.promise();
  const receipt = async () => {
    const [rows] = await connection.query("SELECT payload FROM MarketingPatientContactEvents WHERE list_id=? AND event_type='recipient_patients_registered' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.planSha256'))=? ORDER BY id DESC LIMIT 1", [listId,expectedSha256]);
    return rows.length ? parse(rows[0].payload) : null;
  };
  try {
    if (!apply) {
      await connection.beginTransaction();
      try { return projection(await captureRecipientRegistration(connection, { clinicId,listId })); }
      finally { await connection.rollback(); }
    }
    // Read ownership before looking up any receipt, including a repeated POST.
    const [owned] = await connection.query('SELECT id FROM MarketingPatientLists WHERE id=? AND clinica_id=?', [listId,clinicId]);
    if (!owned.length) throw fail('Listado no encontrado',404);
    const previous = await receipt();
    if (previous) return { success:true,...previous,replayed:true };
    try {
      const result = await applyRecipientRegistration(connection, { clinicId,listId,actorId,expectedSha256,sourceSystem,
        beforeCommit: async ({ result }) => {
          const payload = { clinicId,listId,planSha256:expectedSha256,actorId,sourceSystem,created:result.created,linkedExisting:result.linkedExisting,counts:result.counts,messagesSent:0 };
          await connection.query("INSERT INTO MarketingPatientContactEvents (list_id,event_type,payload,occurred_at,created_at) VALUES (?,'recipient_patients_registered',?,UTC_TIMESTAMP(),UTC_TIMESTAMP())", [listId,JSON.stringify(payload)]);
        } });
      return { success:true,clinicId,listId,created:result.created,linkedExisting:result.linkedExisting,counts:result.counts,messagesSent:0 };
    } catch (error) {
      const completed = await receipt();
      if (completed) return { success:true,...completed,replayed:true };
      throw error;
    }
  } catch (error) {
    if (error.status) throw error;
    if (/RECIPIENT_/.test(error.message)) throw fail(error.message === 'RECIPIENT_LIST_NOT_FOUND' ? 'Listado no encontrado' : 'El listado o sus coincidencias han cambiado, o están siendo registrados. Vuelve a comprobarlos.', error.message === 'RECIPIENT_LIST_NOT_FOUND' ? 404 : 409);
    throw error;
  } finally { await db.sequelize.connectionManager.releaseConnection(raw); }
}
module.exports = { projection, run };
