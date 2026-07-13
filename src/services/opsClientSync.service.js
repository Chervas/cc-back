'use strict';

const DEFAULT_BATCH_SIZE = 50;

function externalClientKey(client = {}) {
  const source = String(client.source_platform || '').trim().toLowerCase();
  const externalId = String(client.external_id ?? '').trim();

  if (!source || !externalId) {
    return null;
  }

  return `${source}\u0000${externalId}`;
}

// OPS uses utf8mb4_0900_ai_ci for clients.name, so case- and accent-only
// differences still collide with its unique name constraint.
function comparableClientName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('es');
}

function planOpsClientSync(payloads = [], existingClients = []) {
  const existingByExternalKey = new Map();
  const existingByName = new Map();

  for (const existing of existingClients) {
    const externalKey = externalClientKey(existing);
    const comparableName = comparableClientName(existing.name);

    if (externalKey) {
      existingByExternalKey.set(externalKey, existing);
    }
    if (comparableName && !existingByName.has(comparableName)) {
      existingByName.set(comparableName, existing);
    }
  }

  const creates = [];
  const updates = [];

  for (const payload of payloads) {
    const existing = existingByExternalKey.get(externalClientKey(payload));

    if (!existing?.id) {
      creates.push(payload);
      continue;
    }

    const updatePayload = { ...payload };
    const nameOwner = existingByName.get(comparableClientName(payload.name));
    const nameConflict = Boolean(nameOwner?.id && String(nameOwner.id) !== String(existing.id));

    // The external key is the provider identity. If a stale OPS row still owns
    // the new display name, keep updating the canonical external row without
    // attempting to steal that independent unique key. `brand` and every other
    // provider field are still refreshed from the unchanged source payload.
    if (nameConflict) {
      delete updatePayload.name;
    }

    updates.push({
      id: existing.id,
      payload: updatePayload,
      name_conflict: nameConflict,
    });
  }

  return { creates, updates };
}

function isDuplicateEntryError(error) {
  return String(
    error?.response?.data?.code
      || error?.code
      || error?.original?.code
      || error?.parent?.code
      || ''
  ).toUpperCase() === 'ER_DUP_ENTRY';
}

async function syncOpsClients(options = {}) {
  const payloads = Array.isArray(options.payloads) ? options.payloads : [];
  const existingClients = Array.isArray(options.existingClients) ? options.existingClients : [];
  const patchClient = options.patchClient;
  const createClients = options.createClients;
  const batchSize = Math.max(1, Number(options.batchSize || DEFAULT_BATCH_SIZE));

  if (typeof patchClient !== 'function' || typeof createClients !== 'function') {
    throw new TypeError('patchClient and createClients are required');
  }

  const plan = planOpsClientSync(payloads, existingClients);
  let updated = 0;
  let created = 0;
  let nameConflicts = plan.updates.filter((item) => item.name_conflict).length;

  for (const update of plan.updates) {
    try {
      await patchClient(update.id, update.payload);
    } catch (error) {
      // The dashboard lists active rows only. An archived row can therefore
      // still own the unique name without appearing in the preflight. Retry the
      // same canonical external row without changing its display name.
      if (!isDuplicateEntryError(error) || !Object.hasOwn(update.payload, 'name')) {
        throw error;
      }

      const safePayload = { ...update.payload };
      delete safePayload.name;
      await patchClient(update.id, safePayload);
      nameConflicts += 1;
    }
    updated += 1;
  }

  for (let index = 0; index < plan.creates.length; index += batchSize) {
    const batch = plan.creates.slice(index, index + batchSize);
    if (!batch.length) {
      continue;
    }
    await createClients(batch);
    created += batch.length;
  }

  return {
    total: updated + created,
    updated,
    created,
    name_conflicts: nameConflicts,
  };
}

module.exports = {
  comparableClientName,
  externalClientKey,
  isDuplicateEntryError,
  planOpsClientSync,
  syncOpsClients,
};
