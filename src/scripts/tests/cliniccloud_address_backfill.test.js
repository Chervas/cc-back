'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { ADDRESS_FIELDS, buildAddressBackfillPlan, validateAddressBackfillPlan } = require('../../lib/cliniccloud-import/address-backfill');

// Owned synthetic records only. No production models, DB connections or exports
// are imported by this suite.
const ADDRESS = {
  direccion: 'Calle Ficticia 10', codigo_postal: '08001',
  poblacion: 'Ciudad Ficticia', provincia: 'Provincia Ficticia', pais: 'España',
};
const SOURCE_COLUMNS = { direccion: 'domicilio', codigo_postal: 'cp', poblacion: 'pobla', provincia: 'provi', pais: 'pais' };

function source(overrides = {}) {
  const row = {
    id: 501, paciente_id: 101, clinica_id: 66,
    source_column: 'contacto_1.csv', field_key: 'cliniccloud_raw_contact:123',
    last_imported_at: '2026-10-03T10:00:00.000Z', sha256: hash('owned synthetic contact 501'),
    contact: { idContacto: '123', idEmpresa: '5880', num: '7', domicilio: ADDRESS.direccion, cp: ADDRESS.codigo_postal,
      pobla: ADDRESS.poblacion, provi: ADDRESS.provincia, pais: ADDRESS.pais },
  };
  return { ...row, ...overrides, contact: { ...row.contact, ...overrides.contact } };
}

function archivedSource(date, overrides = {}) {
  return source({
    id: 601, source_column: `BACKUP_CONTACTOS_${date}.csv`, field_key: `cliniccloud_history_contact_${date.replaceAll('-', '')}_123`,
    record_version: 'cliniccloud_patient_history/1', source_account: 'cliniccloud-5880', source_date: date,
    last_imported_at: '2026-10-14T00:00:00.000Z', sha256: hash(`owned synthetic archive ${date}`),
    ...overrides,
  });
}

function identityLink(overrides = {}) {
  return { id: 701, paciente_id: 101, clinica_id: 66, source_column: 'idContacto', field_key: 'cliniccloud_source_contact_id',
    last_imported_at: '2026-10-03T10:00:00.000Z', sha256: hash('123'), source_contact_id: '123', ...overrides };
}

function fixture() {
  return {
    target: 'dev', generatedAt: '2026-10-14T00:00:00.000Z', scope: { clinicIds: [66, 72], groupId: 29 },
    patients: [{
      id_paciente: 101, numero_historia: '0007', clinica_id: 66, updatedAt: '2026-10-14T00:00:00.000Z',
      direccion: null, codigo_postal: '', poblacion: ' ', provincia: null, pais: null,
      memberships: [{ clinica_id: 66 }, { clinica_id: 72 }],
      nombre: 'Persona Ficticia', apellidos: 'Prueba', email: 'persona@example.invalid',
      telefono_movil: '+34 600 000 001', dni: 'QA-0007',
      notas_paciente: 'Nota administrativa ficticia protegida', consentimientos: { ejemplo: false },
    }],
    sources: [source()],
  };
}

function plan(input = fixture()) { return buildAddressBackfillPlan(input); }
function reasons(result) { return result.reviews.flatMap(item => item.reasons); }
function held(input, reason) {
  const result = plan(input);
  assert.equal(result.operations.length, 0);
  if (reason) assert(reasons(result).includes(reason), `Missing ${reason}: ${JSON.stringify(result.reviews)}`);
  return result;
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

test('the address allowlist is exactly the five canonical address columns', () => {
  assert.deepEqual([...ADDRESS_FIELDS].sort(), Object.keys(ADDRESS).sort());
  assert(!ADDRESS_FIELDS.includes('nombre'));
});

test('fills only empty canonical address fields and preserves postal leading zeroes', () => {
  const f = fixture();
  f.sources[0].contact.domicilio = `  ${ADDRESS.direccion}  `;
  const result = plan(f), operation = result.operations[0];
  assert.equal(result.operations.length, 1);
  assert.equal(operation.patient_id, 101);
  assert.equal(operation.history_number, '0007');
  assert.deepEqual(operation.updates, ADDRESS);
  assert.deepEqual(operation.expected.address, {
    direccion: null, codigo_postal: '', poblacion: ' ', provincia: null, pais: null,
  });
  assert.equal(operation.expected.updatedAt, f.patients[0].updatedAt);
  assert.equal(operation.expected.clinica_id, 66);
});

test('already populated matching address values remain byte-for-byte unchanged', () => {
  const f = fixture();
  f.patients[0].direccion = ` ${ADDRESS.direccion} `;
  f.patients[0].codigo_postal = '08001';
  const operation = plan(f).operations[0];
  assert.deepEqual(operation.updates, {
    poblacion: ADDRESS.poblacion, provincia: ADDRESS.provincia, pais: ADDRESS.pais,
  });
  assert.equal(operation.expected.address.direccion, ` ${ADDRESS.direccion} `);
  assert.equal(operation.expected.address.codigo_postal, '08001');
});

test('a conflicting canonical component holds the whole tuple to avoid mixing addresses', () => {
  for (const field of ADDRESS_FIELDS) {
    const f = fixture(); f.patients[0][field] = field === 'codigo_postal' ? '01001' : 'Otra dirección ficticia';
    held(f, 'CANONICAL_ADDRESS_CONFLICT');
  }
});

test('a fully populated address produces no operation and the same plan has no side effects', () => {
  const f = fixture(); Object.assign(f.patients[0], ADDRESS);
  const before = structuredClone(f);
  assert.equal(plan(f).operations.length, 0);
  assert.deepEqual(f, before);
});

test('canonical identity and unrelated patient fields never appear in an update', () => {
  const f = fixture(), before = structuredClone(f);
  f.sources[0].contact = { ...f.sources[0].contact, nombre: 'Nombre del origen', email: 'origen@example.invalid',
    notas: 'No copiar', telfMovil: '+34 600 000 999', rgpd: 'Sí', whatsapp: 'Sí' };
  const result = plan(f);
  assert.equal(result.operations.length, 1);
  assert.deepEqual(Object.keys(result.operations[0].updates).sort(), [...ADDRESS_FIELDS].sort());
  assert.deepEqual(f.patients, before.patients);
});

test('source history mismatch is held without any name, email or phone fallback', () => {
  const f = fixture(); f.sources[0].contact.num = '8';
  Object.assign(f.sources[0].contact, { nombre: f.patients[0].nombre, email: f.patients[0].email, telfMovil: f.patients[0].telefono_movil });
  held(f, 'SOURCE_HISTORY_MISMATCH');
  const wrongKey = fixture(); wrongKey.sources[0].field_key = 'cliniccloud_raw_contact:999';
  held(wrongKey);
});

test('invalid or missing patient history and source identity never generate updates', () => {
  for (const value of ['', null, '0', '-7', '7.5', '7e1', '9007199254740992']) {
    const f = fixture(); f.patients[0].numero_historia = value;
    held(f);
  }
  for (const value of ['', null, '0', '-123', '123x', {}, '9007199254740992']) {
    const f = fixture(); f.sources[0].contact.idContacto = value;
    held(f);
  }
});

test('conflicting source identities and canonical identity links require review', () => {
  const f = fixture();
  f.sources.push(source({ id: 502, field_key: 'cliniccloud_raw_contact:124', last_imported_at: '2026-10-04T10:00:00.000Z', contact: { idContacto: '124' } }));
  held(f, 'AMBIGUOUS_SOURCE_CONTACT_ID');
  const globallyDuplicated = fixture();
  globallyDuplicated.sources.push(source({ id: 503, paciente_id: 999, clinica_id: 74, contact: { num: '88' } }));
  held(globallyDuplicated, 'AMBIGUOUS_SOURCE_CONTACT_ID');
  const aliases = fixture(); aliases.identityLinks = [identityLink(), identityLink({ id: 702, field_key: 'cliniccloud_contact_alias_124', source_contact_id: '124', sha256: hash('124') })];
  held(aliases, 'IDENTITY_LINK_CONFLICT');
  const otherOwner = fixture(); otherOwner.identityLinks = [identityLink({ paciente_id: 999 })];
  held(otherOwner, 'AMBIGUOUS_SOURCE_CONTACT_ID');
  for (const change of [{ sha256: 'bad-proof' }, { field_key: 'cliniccloud_contact_alias_999' }, { source_column: 'nombre' },
    { source_contact_id: '0' }, { clinica_id: 74 }]) {
    const invalid = fixture(); invalid.identityLinks = [identityLink(change)];
    held(invalid, 'IDENTITY_LINK_INVALID');
  }
});

test('a source must be linked to a real authorized clinic membership', () => {
  const f = fixture(); f.patients[0].memberships = [{ clinica_id: 66 }]; f.sources[0].clinica_id = 72;
  held(f, 'SOURCE_CLINIC_NOT_LINKED');
  const other = fixture(); other.sources[0].clinica_id = 74;
  held(other);
});

test('patients outside both authorized clinics cannot receive address changes', () => {
  const f = fixture();
  f.patients[0].clinica_id = 74; f.patients[0].memberships = [{ clinica_id: 74 }]; f.sources[0].clinica_id = 74;
  held(f);
  const shared = fixture(); shared.patients[0].clinica_id = 74; shared.patients[0].memberships = [{ clinica_id: 66 }];
  assert.equal(plan(shared).operations.length, 1);
  assert.equal(plan(shared).operations[0].expected.clinica_id, 74);
});

test('the clinic and group scope is pinned to clinics 66/72 and group 29', () => {
  for (const scope of [{ clinicIds: [66, 72], groupId: 30 }, { clinicIds: [66, 74], groupId: 29 }, { clinicIds: [66], groupId: 29 }]) {
    const f = fixture(); f.scope = scope;
    assert.throws(() => plan(f), /SCOPE/);
  }
});

test('history archives require the exact trusted version and source account', () => {
  for (const idEmpresa of [undefined, '', '5881', 5881, null, '5880wrong']) {
    const f = fixture(); f.sources[0].contact.idEmpresa = idEmpresa;
    held(f, 'SOURCE_VERSION_OR_ACCOUNT_INVALID');
  }
  for (const change of [{ record_version: 'cliniccloud_patient_history/2' }, { source_account: 'cliniccloud-9999' },
    { record_version: undefined }, { source_account: undefined }]) {
    const f = fixture(); f.sources = [archivedSource('2026-10-03', change)];
    held(f, 'SOURCE_VERSION_OR_ACCOUNT_INVALID');
  }
  for (const change of [{ record_version: 'cliniccloud_contact_snapshot/2' }, { source_account: 'cliniccloud-9999' }]) {
    const f = fixture();
    f.sources = [source({ source_column: 'cliniccloud_contact_snapshot', record_version: 'cliniccloud_contact_snapshot/1',
      source_account: 'cliniccloud-5880', source_date: '2026-10-03', ...change })];
    held(f, 'SOURCE_VERSION_OR_ACCOUNT_INVALID');
  }
});

test('archive source dates must be valid and coherent with the source filename', () => {
  for (const date of ['2026-02-30', '2026-10-04', '', undefined]) {
    const f = fixture(); f.sources = [archivedSource('2026-10-03', { source_date: date })];
    held(f, 'SOURCE_DATE_INVALID');
  }
});

test('explicit archive source date outranks a later import timestamp', () => {
  const f = fixture();
  f.sources = [archivedSource('2026-10-02', { id: 602, last_imported_at: '2026-10-14T00:00:00.000Z',
    contact: { domicilio: 'Dirección antigua ficticia', cp: '01001' } }),
  archivedSource('2026-10-03', { id: 603, last_imported_at: '2026-10-04T00:00:00.000Z' })];
  const result = plan(f);
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.operations[0].updates, ADDRESS);
  assert.equal(result.operations[0].provenance.source_date, '2026-10-03');
  f.sources.push(source({ id: 604, source_column: 'cliniccloud_contact_snapshot', field_key: 'cliniccloud_contact_snapshot',
    record_version: 'cliniccloud_contact_snapshot/1', source_account: 'cliniccloud-5880', source_date: '2026-10-04' }));
  f.sources[2].contact = { idContacto: '123', num: '7' };
  assert.deepEqual(plan(f).operations[0].updates, ADDRESS);
  assert.equal(plan(f).operations[0].provenance.source_date, '2026-10-03');
});

test('a newer blank export never resurrects address values from an older record', () => {
  const f = fixture();
  f.sources = [archivedSource('2026-10-02', { id: 602 }), archivedSource('2026-10-03', {
    id: 603, contact: { domicilio: '', cp: '', pobla: '', provi: '', pais: '' },
  })];
  held(f);
});

test('a partially blank newer export supplies only its own tuple, with no old-field fallback', () => {
  const f = fixture();
  f.sources = [archivedSource('2026-10-02', { id: 602 }), archivedSource('2026-10-03', {
    id: 603, contact: { domicilio: 'Nueva dirección ficticia', cp: '', pobla: '', provi: '', pais: '' },
  })];
  const result = plan(f);
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.operations[0].updates, { direccion: 'Nueva dirección ficticia' });
});

test('conflicting source records at the same freshness hold every address component', () => {
  const f = fixture();
  f.sources.push(source({ id: 502, sha256: hash('conflicting owned source 502'), contact: { cp: '01001' } }));
  held(f, 'LATEST_ADDRESS_CONFLICT');
});

test('address validation rejects nonstrings, NUL, HTML and oversized values without truncation', () => {
  const invalid = [false, 8001, {}, [], 'x\u0000y', '<script>alert(1)</script>', '<div>Calle Ficticia</div>'];
  for (const field of ADDRESS_FIELDS) {
    for (const value of invalid) {
      const f = fixture(); f.sources[0].contact[SOURCE_COLUMNS[field]] = value;
      held(f, 'INVALID_SOURCE_ADDRESS');
    }
    const maximum = field === 'direccion' ? 2000 : field === 'codigo_postal' ? 32 : 255;
    const f = fixture(); f.sources[0].contact[SOURCE_COLUMNS[field]] = 'x'.repeat(maximum + 1);
    held(f, 'INVALID_SOURCE_ADDRESS');
    const unicode = fixture(); unicode.sources[0].contact[SOURCE_COLUMNS[field]] = 'é'.repeat(maximum);
    assert.equal(plan(unicode).operations[0].updates[field], 'é'.repeat(maximum));
  }
});

test('numeric postal codes are held, while postal strings retain all leading zeroes', () => {
  const numeric = fixture(); numeric.sources[0].contact.cp = 8001;
  held(numeric, 'INVALID_SOURCE_ADDRESS');
  const text = fixture(); text.sources[0].contact.cp = '00123';
  assert.equal(plan(text).operations[0].updates.codigo_postal, '00123');
});

test('numeric source countries require a proven country export and preserve mapping provenance', () => {
  const numericText = fixture(); numericText.sources[0].contact.pais = '1';
  held(numericText, 'INVALID_SOURCE_ADDRESS');
  const f = fixture(); f.sources[0].contact.pais = ''; f.sources[0].contact.idPais = '1';
  assert(!Object.hasOwn(plan(f).operations[0].updates, 'pais'));
  f.countries = { values: { 1: 'España' }, provenance: { file: 'pais_1.csv', sha256: hash('owned synthetic country export') } };
  const result = plan(f);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].updates.pais, 'España');
  assert.deepEqual(result.operations[0].provenance.country_mapping, { id: 1, ...f.countries.provenance });
  f.sources[0].contact.idPais = '99';
  assert(!Object.hasOwn(plan(f).operations[0].updates, 'pais'));
  for (const idPais of ['0', '-1', 0, -1]) {
    f.sources[0].contact.idPais = idPais;
    const withoutCountry = plan(f);
    assert.equal(withoutCountry.operations.length, 1);
    assert(!Object.hasOwn(withoutCountry.operations[0].updates, 'pais'));
  }
});

test('country values without a verifiable mapping proof are held', () => {
  for (const provenance of [undefined, { file: 'pais_1.csv' }, { file: 'pais_1.csv', sha256: 'not-a-sha256' }]) {
    const f = fixture(); f.sources[0].contact.pais = ''; f.sources[0].contact.idPais = '1'; f.countries = { values: { 1: 'España' }, provenance };
    assert.throws(() => plan(f), /COUNTRY_MAPPING_PROOF_INVALID/);
  }
});

test('a prepared plan pins selected source fingerprints and retains exact source provenance', () => {
  const f = fixture(); f.sources = [archivedSource('2026-10-03')];
  const result = plan(f), operation = result.operations[0];
  assert.deepEqual(operation.source_fingerprints, [{ id: 601, sha256: f.sources[0].sha256 }]);
  assert.equal(operation.provenance.source_contact_id, 123);
  assert.equal(operation.provenance.sources[0].source_column, 'BACKUP_CONTACTOS_2026-10-03.csv');
  assert.equal(operation.provenance.sources[0].source_date, '2026-10-03');
  assert.equal(operation.provenance.sources[0].record_version, 'cliniccloud_patient_history/1');
  assert.equal(operation.provenance.sources[0].source_account, 'cliniccloud-5880');
  const { plan_sha256, ...body } = result;
  assert.equal(plan_sha256, hash(body));
  assert.deepEqual(validateAddressBackfillPlan(result), result);
  const tampered = structuredClone(result); tampered.operations[0].updates.direccion = 'Dirección alterada';
  assert.throws(() => validateAddressBackfillPlan(tampered), /PROOF_INVALID/);
  const forbidden = structuredClone(result); forbidden.operations[0].updates.nombre = 'No copiar';
  forbidden.plan_sha256 = hash(Object.fromEntries(Object.entries(forbidden).filter(([key]) => key !== 'plan_sha256')));
  assert.throws(() => validateAddressBackfillPlan(forbidden), /ALLOWLIST/);
  const preexisting = structuredClone(result); preexisting.operations[0].expected.address.direccion = 'Texto local protegido';
  preexisting.plan_sha256 = hash(Object.fromEntries(Object.entries(preexisting).filter(([key]) => key !== 'plan_sha256')));
  assert.throws(() => validateAddressBackfillPlan(preexisting), /ALLOWLIST/);
  const falseProof = structuredClone(result); falseProof.operations[0].provenance.sources[0].source_account = 'cliniccloud-9999';
  falseProof.plan_sha256 = hash(Object.fromEntries(Object.entries(falseProof).filter(([key]) => key !== 'plan_sha256')));
  assert.throws(() => validateAddressBackfillPlan(falseProof), /PROOF_INVALID/);
  const falseCompany = plan(fixture()); falseCompany.operations[0].provenance.sources[0].source_company_id = 5881;
  falseCompany.plan_sha256 = hash(Object.fromEntries(Object.entries(falseCompany).filter(([key]) => key !== 'plan_sha256')));
  assert.throws(() => validateAddressBackfillPlan(falseCompany), /PROOF_INVALID/);
  const invalidIdentityProof = plan({ ...fixture(), identityLinks: [] }); invalidIdentityProof.identity_links_sha256 = 'bad-proof';
  invalidIdentityProof.plan_sha256 = hash(Object.fromEntries(Object.entries(invalidIdentityProof).filter(([key]) => key !== 'plan_sha256')));
  assert.throws(() => validateAddressBackfillPlan(invalidIdentityProof), /PROOF_INVALID/);
  const uppercase = fixture();
  uppercase.sources = [archivedSource('2026-10-03')];
  uppercase.sources[0].contact = { IDCONTACTO: '123', NUM: '7', DOMICILIO: ADDRESS.direccion,
    CP: ADDRESS.codigo_postal, POBLACION: ADDRESS.poblacion, PROVINCIA: ADDRESS.provincia, PAIS: ADDRESS.pais };
  assert.deepEqual(plan(uppercase).operations[0].updates, ADDRESS);
});

test('fixed inputs produce a deterministic plan without mutation, including source order permutations', () => {
  const f = fixture();
  f.sources.push(source({ id: 502, sha256: hash('matching owned source 502') }));
  const before = structuredClone(f), result = plan(deepFreeze(f));
  assert.equal(result.operations.length, 1);
  assert.deepEqual(f, before);
  assert.equal(plan(f).plan_sha256, result.plan_sha256);
  const reversed = structuredClone(before); reversed.sources.reverse(); reversed.patients[0].memberships.reverse();
  assert.deepEqual(plan(reversed), result);
  const linked = fixture(); linked.identityLinks = [identityLink({ id: 702, clinica_id: 72 }), identityLink()];
  const withLinks = plan(deepFreeze(linked));
  assert.equal(withLinks.operations.length, 1);
  assert.match(withLinks.identity_links_sha256, /^[a-f0-9]{64}$/);
  const reversedLinks = structuredClone(linked); reversedLinks.identityLinks.reverse();
  assert.deepEqual(plan(reversedLinks), withLinks);
  const noLinks = fixture(); noLinks.identityLinks = [];
  assert.equal(plan(noLinks).identity_links_sha256, hash([]));
  for (const field_key of ['cliniccloud_source_contact_id:123', 'cliniccloud_source_contact_id_123', 'cliniccloud_contact_alias_123']) {
    const variant = fixture(); variant.identityLinks = [identityLink({ field_key })];
    assert.equal(plan(variant).operations.length, 1);
  }
});

test('a second prepare after applying its address values is idempotent', () => {
  const f = fixture(), first = plan(f);
  assert.equal(first.operations.length, 1);
  Object.assign(f.patients[0], first.operations[0].updates);
  f.patients[0].updatedAt = '2026-10-14T00:01:00.000Z';
  const second = plan(f);
  assert.equal(second.operations.length, 0);
  assert.deepEqual(Object.fromEntries(ADDRESS_FIELDS.map(field => [field, f.patients[0][field]])), ADDRESS);
});
