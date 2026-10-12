'use strict';
const { fail } = require('./errors');
const C = require('./whatsapp-authorized-contract');
const DEFAULTS = Object.freeze({ maxInFlight: 8, managementSlots: 2, clinicSlots: 2,
  maxPerMinute: 600, managementReserve: 100, clinicalReserve: 200,
  clinicPerMinute: 120, commercialClinicPerMinute: 30 });
function validate(value = DEFAULTS) {
  if (!C.keys(value, Object.keys(DEFAULTS)) || Object.values(value).some(n => !Number.isInteger(n) || n < 1)
    || value.maxInFlight > 32 || value.managementSlots >= value.maxInFlight
    || value.clinicSlots > value.maxInFlight - value.managementSlots
    || value.maxPerMinute > 600 || value.managementReserve + value.clinicalReserve >= value.maxPerMinute
    || value.clinicPerMinute > value.maxPerMinute || value.commercialClinicPerMinute > value.clinicPerMinute) fail('invalid_request');
  return Object.freeze({ ...value });
}
// One gate in the existing authorized runtime. No Meta calls or credentials are
// needed to reserve capacity. Windows persist across process restarts.
function createCapacity({ store, settings = DEFAULTS, now = () => Date.now() }) {
  const limits = validate(settings); let total = 0; let sends = 0; let ordinary = 0;
  const clinics = new Map(); const commercial = new Map();
  store.db.exec('CREATE TABLE IF NOT EXISTS whatsapp_dispatch_demand (tenant TEXT NOT NULL,lane TEXT NOT NULL,turn INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,PRIMARY KEY(tenant,lane))');
  const remember = (tenant, lane) => store.db.prepare('INSERT INTO whatsapp_dispatch_demand SELECT ?,?,COALESCE(MAX(turn),0)+1,? FROM whatsapp_dispatch_demand WHERE 1 ON CONFLICT(tenant,lane) DO UPDATE SET last_seen_at=excluded.last_seen_at').run(tenant, lane, now());
  return {
    limits,
    lane(operation) {
      return operation === C.SEND ? 'send' : [C.REVOKE, require('./whatsapp-authorized-status').READ,
        require('./whatsapp-authorized-profile').READ].includes(operation) ? 'management' : 'technical';
    },
    acquire({ request }) {
      const sending = request.operation === C.SEND;
      const management = this.lane(request.operation) === 'management';
      const lane = sending ? request.payload.dispatchLane || 'clinical' : 'management';
      const tenant = request.tenantRef;
      store.db.prepare('DELETE FROM whatsapp_dispatch_demand WHERE last_seen_at<?').run(now() - 90000);
      if (total >= limits.maxInFlight || !management && ordinary >= limits.maxInFlight - limits.managementSlots
        || sending && (sends >= limits.maxInFlight - limits.managementSlots
        || (clinics.get(tenant) || 0) >= limits.clinicSlots
        || lane === 'commercial' && (commercial.get(tenant) || 0) >= 1)) {
        if (sending) remember(tenant, lane); fail('whatsapp_capacity_concurrency');
      }
      try { store.transaction(() => {
        const window = Math.floor(now() / 60000);
        const get = key => Number(store.db.prepare('SELECT count FROM rate_windows WHERE principal=? AND window=?').get(key, window)?.count || 0);
        const tests = [['wa-capacity:global', limits.maxPerMinute]];
        if (!management) tests.push(['wa-capacity:ordinary', limits.maxPerMinute - limits.managementReserve]);
        if (sending) {
          tests.push(['wa-capacity:send', limits.maxPerMinute - limits.managementReserve],
            ['wa-capacity:clinic:' + tenant, limits.clinicPerMinute]);
          if (lane === 'commercial') tests.push(['wa-capacity:commercial', limits.maxPerMinute - limits.managementReserve - limits.clinicalReserve],
            ['wa-capacity:commercial:' + tenant, limits.commercialClinicPerMinute]);
        }
        if (tests.some(([key, max]) => get(key) >= max)) fail('whatsapp_capacity_minute');
        if (sending) {
          const own = store.db.prepare('SELECT turn FROM whatsapp_dispatch_demand WHERE tenant=? AND lane=?').get(tenant, lane);
          const turn = own?.turn ?? store.db.prepare('SELECT COALESCE(MAX(turn),0)+1 n FROM whatsapp_dispatch_demand').get().n;
          // A clinic whose request is in flight, quota-exhausted, or no longer
          // polling cannot stall its peers. A turn reservation lasts <=5 s.
          const earlier = store.db.prepare('SELECT tenant FROM whatsapp_dispatch_demand WHERE lane=? AND tenant<>? AND turn<? AND last_seen_at>=? ORDER BY turn LIMIT 2001').all(lane, tenant, turn, now() - 5000);
          if (earlier.some(other => (clinics.get(other.tenant) || 0) < limits.clinicSlots
            && get('wa-capacity:clinic:' + other.tenant) < limits.clinicPerMinute
            && (lane !== 'commercial' || (commercial.get(other.tenant) || 0) < 1
              && get('wa-capacity:commercial:' + other.tenant) < limits.commercialClinicPerMinute))) fail('whatsapp_capacity_fairness');
          store.db.prepare('DELETE FROM whatsapp_dispatch_demand WHERE tenant=? AND lane=?').run(tenant, lane);
        }
        for (const [key] of tests) store.db.prepare('INSERT INTO rate_windows VALUES (?,?,1) ON CONFLICT(principal,window) DO UPDATE SET count=count+1').run(key, window);
      }); } catch (error) { if (sending) remember(tenant, lane); throw error; }
      total += 1;
      if (!management) ordinary += 1;
      if (sending) { sends += 1; clinics.set(tenant, (clinics.get(tenant) || 0) + 1);
        if (lane === 'commercial') commercial.set(tenant, (commercial.get(tenant) || 0) + 1); }
      let released = false;
      return () => {
        if (released) return; released = true; total -= 1; if (!management) ordinary -= 1;
        if (sending) { sends -= 1;
          const decrement = map => { const n = (map.get(tenant) || 0) - 1; if (n > 0) map.set(tenant, n); else map.delete(tenant); };
          decrement(clinics); if (lane === 'commercial') decrement(commercial); }
      };
    },
  };
}
module.exports = { DEFAULTS, validate, createCapacity };
