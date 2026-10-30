"use strict";
const { createHash } = require("node:crypto");
const { identity, binding } = require("./googleAdsBrokerScope.service");
const fail = code => { throw Object.assign(Error(code), { code }); };
const bounded = rows => { if (!Array.isArray(rows) || rows.length > 1000) fail("broker_binding_invalid"); return rows; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const active = row => row && [true, 1].includes(row.isActive);
// This facade contains no credential fallback or independent authorization.
// The native group Scope remains the sole authorizer and revalidates every
// participating mapping/registry/assignment/revocation before each operation.
function createGoogleAdsCanonicalAliasScope({ nativeScope, loadMapping, loadMappings, loadBindings }) {
  const aliases = new WeakMap();
  function exterior(canonical, alias) {
    if (canonical.scopeKey !== "group:" + alias.groupId || canonical.groupId !== alias.groupId
      || !canonical.clinicIds.includes(alias.clinicId) || canonical.googleConnectionId !== alias.googleConnectionId
      || canonical.customerId !== alias.customerId || canonical.loginCustomerId !== alias.loginCustomerId) fail("scope_denied");
    return { ...canonical, ...alias, clinicIds: [alias.clinicId] };
  }
  async function assertContext(context, options) {
    const saved = context && typeof context === "object" && aliases.get(context);
    if (!saved) return nativeScope.assertContext(context, options);
    const rows = bounded(await loadMappings(saved.alias.customerId, options?.transaction));
    const current = rows.filter(row => Number(row.id) === saved.alias.id);
    if (current.length !== 1 || !active(current[0]) || !same(identity(current[0]), saved.alias)) fail("broker_binding_invalid");
    const records = bounded(await loadBindings(saved.alias.customerId, saved.alias.id, options?.transaction)).map(binding);
    const captured = await nativeScope.assertContext(saved.nativeContext, options);
    const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const included = rows.filter(row => active(row) || captured.discoveryOnly && records.some(r => r.mapping_id === Number(row.id) && r.state === "staged"));
    if (hash(included.map(identity).sort((a,b) => a.id-b.id)) !== captured.mappingsHash
      || hash(records.slice().sort((a,b) => a.mapping_id-b.mapping_id)) !== captured.registryHash
      || current[0].broker_read_connection_ref !== captured.connectionRef
      || current[0].broker_read_asset_ref !== captured.assetRef) fail("broker_binding_invalid");
    // Native hashes include the active alias and its independent registry. Its
    // deletion, blocking, movement, reference change or override invalidates the
    // native capture. No old caller snapshot can replace that durable readback.
    const outer = exterior(captured, saved.alias);
    if (!same(outer, saved.captured)) fail("broker_binding_invalid");
    return outer;
  }
  async function prepare(mapping, options = {}) {
    try { return await nativeScope.prepare(mapping, options); }
    catch (error) { if (error?.code !== "scope_denied") throw error; }
    // A denied active direct mapping may be an exact alias of a unique group
    // mapping. Revocation, absent registry and transport failure never enter here.
    const expected = identity(mapping);
    if (!expected.scopeKey.startsWith("clinic:") || expected.groupId == null) fail("scope_denied");
    const current = await loadMapping(expected.id, options.transaction);
    if (!active(current) || !same(identity(current), expected)
      || !current.broker_read_connection_ref || !current.broker_read_asset_ref) fail("broker_binding_invalid");
    const rows = bounded(await loadMappings(expected.customerId, options.transaction));
    if (new Set(rows.map(row => row?.id)).size !== rows.length) fail("broker_binding_invalid");
    const canonical = rows.filter(row => active(row) && row.assignmentScope === "group"
      && Number(row.grupoClinicaId) === expected.groupId);
    if (canonical.length !== 1) fail("scope_denied");
    const owner = canonical[0], ownerId = identity(owner);
    if (ownerId.customerId !== expected.customerId || ownerId.googleConnectionId !== expected.googleConnectionId
      || ownerId.loginCustomerId !== expected.loginCustomerId
      || owner.broker_read_connection_ref !== current.broker_read_connection_ref
      || owner.broker_read_asset_ref !== current.broker_read_asset_ref) fail("scope_denied");
    const nativeContext = await nativeScope.prepare(owner, options);
    if (!nativeContext) fail("broker_binding_invalid");
    const captured = exterior(await nativeScope.assertContext(nativeContext, options), expected);
    // The actual native group inspection proves the alias is still an active
    // member with the same tuple/subject/tenant and current clinic membership.
    const context = Object.freeze({}); aliases.set(context, { nativeContext, alias: expected, captured });
    await assertContext(context, options); return context;
  }
  const guarded = fn => async (...args) => { try { return await fn(...args); } catch (error) {
    fail(["scope_denied", "asset_revoked", "broker_binding_invalid", "broker_cohort_disabled"].includes(error?.code) ? error.code : "broker_binding_invalid");
  } };
  return { prepare: guarded(prepare), assertContext: guarded(assertContext) };
}
module.exports = { createGoogleAdsCanonicalAliasScope };
