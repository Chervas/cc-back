'use strict';
const { createHash, randomUUID } = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyFor = (phoneId, peer) => hash([phoneId, peer]);
const fail = code => { throw Object.assign(Error(code), { code, inboxReason: 'review_required' }); };
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const enabled = () => process.env.WHATSAPP_INBOX_ROUTING_REVIEW_ENABLED === 'true';

const SCHEMA = [
  `CREATE TABLE WhatsappInboxRoutingReviews (
    id CHAR(36) PRIMARY KEY, routing_key CHAR(64) NOT NULL UNIQUE,
    asset_id INT NOT NULL, phone_id VARCHAR(30) NOT NULL, waba_id VARCHAR(30) NOT NULL,
    scope_clinics JSON NOT NULL, candidates JSON NOT NULL, revision INT NOT NULL DEFAULT 1,
    status VARCHAR(16) NOT NULL DEFAULT 'pending', selected_clinic_id INT NULL,
    selected_conversation_id INT NULL, resolved_by INT NULL, resolved_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    INDEX routing_status (status,updated_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE WhatsappInboxRoutingReviewReceipts (
    receipt CHAR(36) NOT NULL, part_index INT NOT NULL, review_id CHAR(36) NOT NULL,
    digest CHAR(64) NOT NULL, received_at DATETIME(3) NOT NULL, imported_at DATETIME(3) NULL,
    retry_requested_at DATETIME(3) NULL,
    PRIMARY KEY(receipt,part_index), INDEX routing_receipts (review_id,imported_at)
  ) ENGINE=InnoDB`,
];

function sameScope(row, scope) {
  return row.asset_id === scope.assetId && row.phone_id === scope.phoneId && row.waba_id === scope.wabaId
    && JSON.stringify(json(row.scope_clinics)) === JSON.stringify(scope.clinicIds);
}

async function decision(connection, part, { receipt, partIndex } = {}) {
  const [rows] = await connection.execute('SELECT * FROM WhatsappInboxRoutingReviews WHERE routing_key=?',
    [keyFor(part.scope.phoneId, part.route.peer)]);
  const row = rows[0];
  if (!row || row.status !== 'resolved') return null;
  if (!sameScope(row, part.scope) || !part.scope.clinicIds.includes(row.selected_clinic_id)) fail('routing_scope_changed');
  const [conversations] = await connection.execute("SELECT id,clinic_id,contact_id FROM Conversations WHERE id=? AND clinic_id=? AND channel='whatsapp'",
    [row.selected_conversation_id, row.selected_clinic_id]);
  if (conversations.length !== 1 || keyFor(row.phone_id, String(conversations[0].contact_id).replace(/^\+/, '')) !== row.routing_key)
    fail('routing_conversation_changed');
  const [retained] = receipt ? await connection.execute('SELECT digest FROM WhatsappInboxRoutingReviewReceipts WHERE receipt=? AND part_index=? AND review_id=?',
    [receipt, partIndex, row.id]) : [[]];
  if (retained.length && retained[0].digest !== createHash('sha256').update(JSON.stringify(part.packet)).digest('hex')) fail('routing_receipt_changed');
  return { clinicId: row.selected_clinic_id, recovered: retained.length > 0 };
}

async function retain(connection, part, lease, partIndex, now) {
  if (!lease?.receipt || !Number.isSafeInteger(partIndex)) fail('routing_receipt_invalid');
  const raw = Buffer.from(JSON.stringify(part.packet));
  try { require('./whatsappInboxImport').normalize(raw, { clinicId: part.scope.clinicIds[0], wabaId: part.scope.wabaId, phoneId: part.scope.phoneId }, now); }
  finally { raw.fill(0); }
  const marks = part.scope.clinicIds.map(() => '?').join(',');
  let transaction = false;
  try {
    await connection.beginTransaction(); transaction = true;
    await require('./whatsappInboxScopes').assertScope(connection, part.scope, { lock: true });
    const [rows] = await connection.execute("SELECT id,clinic_id FROM Conversations WHERE clinic_id IN (" + marks
      + ") AND channel='whatsapp' AND contact_id IN (?,?) ORDER BY clinic_id,id FOR SHARE",
    [...part.scope.clinicIds, part.route.peer, '+' + part.route.peer]);
    // Only an actual multi-clinic ambiguity belongs in this UI. Unknown contacts,
    // broken bindings and mixed events remain technical reviews.
    if (new Set(rows.map(row => row.clinic_id)).size < 2 || rows.length > 128) fail('routing_candidates_unavailable');
    const candidates = rows.map(row => ({ clinicId: row.clinic_id, conversationId: row.id }));
    const routingKey = keyFor(part.scope.phoneId, part.route.peer);
    const at = new Date(now);
    await connection.execute(`INSERT INTO WhatsappInboxRoutingReviews
      (id,routing_key,asset_id,phone_id,waba_id,scope_clinics,candidates,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)`,
    [randomUUID(), routingKey, part.scope.assetId, part.scope.phoneId, part.scope.wabaId,
      JSON.stringify(part.scope.clinicIds), JSON.stringify(candidates), at, at]);
    const [[review]] = await connection.execute('SELECT * FROM WhatsappInboxRoutingReviews WHERE routing_key=? FOR UPDATE', [routingKey]);
    if (review.status !== 'pending' || !sameScope(review, part.scope)) fail('routing_review_changed');
    if (JSON.stringify(json(review.candidates)) !== JSON.stringify(candidates)) {
      await connection.execute('UPDATE WhatsappInboxRoutingReviews SET candidates=?,revision=revision+1 WHERE id=?', [JSON.stringify(candidates), review.id]);
    }
    const digest = createHash('sha256').update(JSON.stringify(part.packet)).digest('hex');
    const [previous] = await connection.execute('SELECT review_id,digest FROM WhatsappInboxRoutingReviewReceipts WHERE receipt=? AND part_index=? FOR UPDATE', [lease.receipt, partIndex]);
    if (previous.length && (previous[0].review_id !== review.id || previous[0].digest !== digest)) fail('routing_receipt_changed');
    if (!previous.length) await connection.execute('INSERT INTO WhatsappInboxRoutingReviewReceipts(receipt,part_index,review_id,digest,received_at) VALUES(?,?,?,?,?)',
      [lease.receipt, partIndex, review.id, digest, new Date(lease.receivedAt || now)]);
    await connection.commit(); transaction = false;
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  }
}

async function pending(connection, conversationIds, authorize) {
  if (!conversationIds.length) return [];
  const [rows] = await connection.execute(`SELECT r.*, (SELECT COUNT(*) FROM WhatsappInboxRoutingReviewReceipts p
    WHERE p.review_id=r.id AND p.imported_at IS NULL) AS pending_count FROM WhatsappInboxRoutingReviews r
    WHERE r.status='pending' AND (` + conversationIds.map(() => "JSON_CONTAINS(r.candidates,JSON_OBJECT('conversationId',?))").join(' OR ')
    + ') ORDER BY r.created_at LIMIT 200', conversationIds);
  const result = [];
  for (const row of rows) {
    const candidates = json(row.candidates);
    const [conversations] = await connection.execute("SELECT id,clinic_id,contact_id,patient_id,lead_id FROM Conversations WHERE id IN ("
      + candidates.map(() => '?').join(',') + ')', candidates.map(c => c.conversationId));
    // Do not disclose another clinic or its contact category to a user who
    // cannot read that conversation. All options require explicit access.
    if (conversations.length !== candidates.length) continue;
    let allowed = true;
    for (const conversation of conversations) {
      if (!candidates.some(c => c.conversationId === conversation.id && c.clinicId === conversation.clinic_id)
        || keyFor(row.phone_id, String(conversation.contact_id).replace(/^\+/, '')) !== row.routing_key
        || !await authorize(conversation)) { allowed = false; break; }
    }
    if (!allowed) continue;
    const clinicIds = [...new Set(candidates.map(c => c.clinicId))];
    const [clinics] = await connection.execute('SELECT id_clinica AS id,nombre_clinica AS nombre FROM Clinicas WHERE id_clinica IN (' + clinicIds.map(() => '?').join(',') + ')', clinicIds);
    result.push({ id: row.id, revision: row.revision, pendingCount: Number(row.pending_count), createdAt: row.created_at,
      conversationIds: candidates.map(c => c.conversationId),
      clinics: clinics.map(c => ({ id: c.id, name: c.nombre })) });
  }
  return result;
}

async function resolve(connection, { conversationId, reviewId, clinicId, revision, userId, scopes, authorize }) {
  let transaction = false;
  try {
    await connection.beginTransaction(); transaction = true;
    const [[row]] = await connection.execute('SELECT * FROM WhatsappInboxRoutingReviews WHERE id=? FOR UPDATE', [reviewId]);
    if (!row || row.status !== 'pending' || row.revision !== revision) fail('routing_review_changed');
    // API reads no inbox credentials/configuration. Revalidate the immutable
    // captured identity against live asset ownership; the importer separately
    // checks its protected activation catalogue before any import.
    const scope = scopes ? scopes.find(s => s.phoneId === row.phone_id)
      : { assetId: row.asset_id, phoneId: row.phone_id, wabaId: row.waba_id, clinicIds: json(row.scope_clinics) };
    if (!scope || !sameScope(row, scope)) fail('routing_scope_changed');
    await require('./whatsappInboxScopes').assertScope(connection, scope, { lock: true });
    const candidates = json(row.candidates);
    if (!candidates.some(c => c.conversationId === conversationId)) fail('routing_review_forbidden');
    const [conversations] = await connection.execute("SELECT id,clinic_id,contact_id,patient_id,lead_id FROM Conversations WHERE id IN ("
      + candidates.map(() => '?').join(',') + ') FOR SHARE', candidates.map(c => c.conversationId));
    if (conversations.length !== candidates.length) fail('routing_conversation_changed');
    for (const conversation of conversations) {
      if (!candidates.some(c => c.conversationId === conversation.id && c.clinicId === conversation.clinic_id)
        || keyFor(row.phone_id, String(conversation.contact_id).replace(/^\+/, '')) !== row.routing_key) fail('routing_conversation_changed');
      if (!await authorize(conversation)) fail('routing_review_forbidden');
    }
    const selected = conversations.filter(c => c.clinic_id === clinicId);
    if (selected.length !== 1) fail('routing_candidates_unavailable');
    await connection.execute(`UPDATE WhatsappInboxRoutingReviews SET status='resolved',selected_clinic_id=?,
      selected_conversation_id=?,resolved_by=?,resolved_at=NOW(3),updated_at=NOW(3),revision=revision+1 WHERE id=?`,
    [clinicId, selected[0].id, userId, reviewId]);
    await connection.commit(); transaction = false;
    return { resolved: true, clinicId };
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  }
}
async function withConnection(sequelize, run) {
  const raw = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
  try { return await run(raw.promise()); }
  finally { await sequelize.connectionManager.releaseConnection(raw); }
}
async function resumeResolved(connection, client, scopes) {
  const [rows] = await connection.execute(`SELECT DISTINCT p.receipt,r.phone_id,r.asset_id,r.waba_id,r.scope_clinics
    FROM WhatsappInboxRoutingReviewReceipts p JOIN WhatsappInboxRoutingReviews r ON r.id=p.review_id
    WHERE r.status='resolved' AND p.imported_at IS NULL
    AND (p.retry_requested_at IS NULL OR p.retry_requested_at<DATE_SUB(NOW(3),INTERVAL 1 MINUTE))
    ORDER BY p.receipt LIMIT 20`);
  for (const row of rows) {
    const scope = scopes.find(s => s.phoneId === row.phone_id);
    if (!scope || !sameScope(row, scope)) continue;
    try { await require('./whatsappInboxScopes').assertScope(connection, scope); }
    catch { continue; }
    // One bounded maintenance request, after fresh imports. Stamp the attempt
    // before transport so a provider outage cannot create a tight retry loop.
    await connection.execute('UPDATE WhatsappInboxRoutingReviewReceipts SET retry_requested_at=NOW(3) WHERE receipt=? AND imported_at IS NULL', [row.receipt]);
    let result;
    try { result = await client.request('POST', '/resume-review', { receipt: row.receipt }); }
    catch { return { retryScheduled: false }; }
    return { retryScheduled: result.status === 200 && result.data?.retryScheduled === true && result.data.businessProcessed === false };
  }
  return { retryScheduled: false };
}
module.exports = { SCHEMA, enabled, keyFor, decision, retain, pending, resolve, resumeResolved, withConnection };
