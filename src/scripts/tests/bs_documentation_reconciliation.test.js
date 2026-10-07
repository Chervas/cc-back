'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { WORKBOOK_SHA, PDF_SOURCES } = require('../../lib/cliniccloud-import/catalog-matrix');
const { VERSION: PREFLIGHT_VERSION, reconcileCatalog } = require('../../lib/cliniccloud-import/catalog-preflight');
const { prepareDocumentationReconciliation: prepare, verifyDocumentationReconciliation: verify,
    assessDocumentationReplay: replay, documentationReconciliationCsv: csv } = require('../../lib/cliniccloud-import/bs-documentation-reconciliation');
const clone = value => JSON.parse(JSON.stringify(value));
const seal = (body, key) => ({ ...body, [key]: hash(body) });

function fixture() {
    const rows = [], sources = [], treatments = [];
    for (let index = 0; index < 167; index++) {
        const category = 'Radiofrecuencia con ultrasonido', name = index === 0 ? 'EXION Body + INDIBA' : `Acto ficticio ${index}`;
        const sheet = 'Tratamientos individuales', raw_cells = { A: category, B: name, C: '45 min', D: '90 €' };
        const key = hash([sheet, category, name]);
        const provenance = { file_sha256: WORKBOOK_SHA, sheet, source_row: index + 2, row_sha256: hash(raw_cells) };
        sources.push({ category, name, detail: '', sheet, source_row: index + 2, raw_cells, provenance,
            source_catalog_key: key, proposed_code: `BS26-${key.slice(0, 20)}`, clinic_id: 72 });
        rows.push({ record_type: 'concept', kind: 'treatment', matrix_key: key, code: `BS26-${key.slice(0, 20)}`,
            clinic: 'BS Medical', name, source_references_json: JSON.stringify([provenance]), pending_json: '[]' });
        treatments.push({ id_tratamiento: 100 + index, clinica_id: 72, codigo: rows[index].code, nombre: name, activo: 1,
            clinical_config: { source_catalog_key: key, source_catalog: provenance, catalog_status: 'active' } });
    }
    while (rows.length < 895) rows.push({ record_type: 'source_manifest', matrix_key: hash(['ficticio', rows.length]) });
    const templates = [10, 11].map(id => ({ id, clinic_id: 72, name: `Consentimiento ficticio ${id}`,
        purpose: 'clinical', status: 'active', validity_mode: 'single_act', blocking_policy: 'hard' }));
    const versions = templates.map(template => ({ id: 1000 + template.id, clinic_template_id: template.id, version: 1,
        status: 'published', locale: 'es', body_html: `<p>Documento ficticio de ${template.id === 10 ? 'radiofrecuencia' : 'ultrasonidos'} para este acto individual.</p>`,
        variable_schema: { source: { type: 'synthetic_fixture' } } }));
    const requirement = { id: 1, tratamiento_id: 100, clinica_id: 72, clinic_template_id: 10, catalog_template_id: null,
        requirement_scope: 'treatment', condition_key: null, required: 1, blocking_policy: 'hard', sort_order: 0 };
    const manual = PDF_SOURCES.find(source => source.area === 'corporal' && source.role === 'manual');
    const pages = Array.from({ length: manual.pages }, (_, i) => `Página ficticia ${i + 1}, no instrucciones clínicas.`);
    const protocol = { id: 14, clinic_id: 72, version: 1, kind: 'protocol', status: 'draft', title: 'Manual ficticio',
        approved_by: null, approved_at: null, treatment_ids: [], source: `cliniccloud:manual-corporal:sha256:${manual.sha256}; importación ficticia`,
        content: pages.map((page, i) => `## Página ${i + 1} del PDF\n\n\u0060\u0060\u0060pdf-text\n${page}\n\u0060\u0060\u0060\n`).join('\n') };
    treatments[0].clinical_config.source_corporal_profile = { pdf_sha256: manual.sha256, pages: [12, 13], clinical_approval: false };
    const snapshot = { clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }],
        triggers: [], treatments, consent_templates: templates, consent_versions: versions,
        consent_requirements: [requirement], protocols: [protocol], appointment_counts: [], voucher_counts: [] };
    const sourcePlan = seal({ version: 1, mode: 'catalog_dry_run_only', clinics: { medical: 72, capilar: 66 }, workbook_sha256: WORKBOOK_SHA, rows: sources }, 'plan_sha256');
    const binding = id => ({ source_catalog_key: rows[0].matrix_key, clinic_template_id: id,
        template_sha256: hash(templates.find(template => template.id === id)), version_id: 1000 + id,
        version_sha256: hash(versions.find(version => version.id === 1000 + id)),
        source_quote: id === 10 ? 'INDIBA' : 'ultrasonido', document_quote: versions.find(version => version.id === 1000 + id).body_html.slice(3, -4),
        reason: 'Vínculo documental ficticio exacto, sin aprobación clínica ni firma del paciente.' });
    const review = { version: 1, scope: 'exact_documentary_reconciliation', plan_sha256: hash('historical-plan-fixture'),
        clinical_approval: false, legal_approval: false, bindings: [binding(10), binding(11), binding(10)] };
    const artifact = { key: 'ficticio', document: review, document_sha256: hash(review) };
    const preflight = { version: PREFLIGHT_VERSION, target: 'crm', mode: 'read_only', group_id: 29,
        created_at: '2026-10-06T22:00:00Z', matrix_file_sha256: hash('ficticio-matrix'), snapshot,
        snapshot_sha256: hash(snapshot), reconciliation: reconcileCatalog(rows, snapshot), policy: {
            database_written: false, patient_rows_exported: false, application_bootstrapped: false, reminders_sent: false,
            protocols_approved: false, treatments_activated: false, existing_entitlements_unchanged: true } };
    const input = { matrixRows: rows, matrixFileSha256: preflight.matrix_file_sha256, preflight, sourcePlan,
        evidenceArtifacts: [artifact], manualSources: [{ ...manual, pages }] };
    return { input, snapshot, rows, sources, templates, versions, requirement, review, artifact, protocol, binding,
        reseal: () => { preflight.snapshot_sha256 = hash(snapshot); preflight.reconciliation = reconcileCatalog(rows, snapshot);
            artifact.document_sha256 = hash(review); } };
}

test('exact source identity, literal document versions and draft page associations produce a deterministic append-only proposal', () => {
    const h = fixture(), before = JSON.stringify(h.input), plan = prepare(h.input);
    assert.equal(plan.summary.exact_treatments, 167);
    assert.equal(plan.summary.verified_literal_requirement_links, 1);
    assert.equal(plan.consent_operations.length, 1, 'same effective RF document is not requested twice');
    assert.equal(plan.consent_operations[0].values.clinic_template_id, 11);
    assert.deepEqual(plan.protocol_operations[0].add_treatment_ids, [100]);
    assert.equal(plan.protocol_operations[0].approved, false);
    assert.equal(plan.protocol_operations[0].available_at_care_start, false);
    assert.equal(plan.summary.clinical_coverage_declared_complete, 0);
    assert.equal(plan.policy.patient_documents_created, false);
    assert.equal(plan.policy.initial_form_is_not_consent, true);
    assert.equal(JSON.stringify(h.input), before);
    assert.deepEqual(prepare(h.input), plan);
    assert.equal(verify(plan, h.input), true);
    assert.equal(replay(plan, h.snapshot).write_permitted, false);
});

test('same-name, wrong row provenance and an edited original literal never establish a source association', () => {
    const h = fixture(); h.snapshot.treatments[0].codigo = 'CCLOUD-historical'; h.reseal();
    assert.throws(() => prepare(h.input), /BS_DOC_EXACT_IDENTITY_REQUIRED/);
    const different = fixture(); different.sources[0].name = 'Parecido';
    different.input.sourcePlan = seal({ ...different.input.sourcePlan, rows: different.sources, plan_sha256: undefined }, 'plan_sha256');
    assert.throws(() => prepare(different.input), /BS_DOC_SOURCE_LITERAL_CHANGED/);
});

test('newer drafts, another language, template edits and nonclinical forms remain pending instead of using an old matching document', () => {
    for (const change of [h => h.versions.push({ ...h.versions[0], id: 2000, version: 2, status: 'draft' }),
        h => { h.versions[0].locale = 'en'; }, h => { h.templates[0].name = 'Texto editado'; },
        h => { h.templates[0].purpose = 'intake'; }]) {
        const h = fixture(); change(h); h.reseal(); const plan = prepare(h.input);
        assert.equal(plan.records[0].consent_links[0].status, 'existing_link_preserved_pending_literal_review');
        assert.equal(plan.preserved_requirements.length, 1);
        assert.equal(plan.consent_operations.filter(operation => operation.values.clinic_template_id === 10).length, 0);
        assert.equal(plan.summary.clinical_coverage_declared_complete, 0);
    }
});

test('a scoped requirement in another clinic cannot be declared effectively covered just because its template matches', () => {
    const h = fixture(); h.requirement.clinica_id = 66; h.reseal();
    const link = prepare(h.input).records[0].consent_links[0];
    assert.equal(link.status, 'existing_link_preserved_pending_literal_review');
    assert.deepEqual(link.pending_reasons, ['REQUISITO_CON_AMBITO_O_CONDICION_NO_VERIFICADA']);
});

test('missing literal manual, changed page and approved protocol never authorize a draft association or inherit approval', () => {
    for (const change of [h => { h.input.manualSources = []; }, h => { h.input.manualSources[0].pages[11] += ' cambiado'; },
        h => { h.protocol.status = 'approved'; h.protocol.approved_by = 7; h.protocol.approved_at = '2026-10-06'; }]) {
        const h = fixture(); change(h); h.reseal(); const plan = prepare(h.input);
        assert.equal(plan.protocol_operations.length, 0);
        assert(plan.records[0].protocol_pending);
        assert.equal(plan.policy.protocols_approved, false);
    }
});

test('literal combined-act coverage does not duplicate a shared RF and keeps the unconfigured/unknown act visible', () => {
    const h = fixture();
    h.input.coverageReview = seal({ version: 1, scope: 'literal_documentary_act_coverage', clinical_approval: false, legal_approval: false,
        concepts: [{ matrix_key: h.rows[0].matrix_key, kind: 'combined', acts: [
            { key: 'exion', label: 'EXION ficticio', source_quote: 'EXION', document_bindings: [{ clinic_template_id: 10, document_quote: h.binding(10).document_quote }] },
            { key: 'indiba', label: 'INDIBA ficticio', source_quote: 'INDIBA', document_bindings: [{ clinic_template_id: 10, document_quote: h.binding(10).document_quote }] },
            { key: 'ultrasonido', label: 'Ultrasonido ficticio', source_quote: 'ultrasonido', document_bindings: [] },
        ] }] }, 'review_sha256');
    const plan = prepare(h.input), record = plan.records[0];
    assert.equal(record.composition_kind, 'combined');
    assert.deepEqual(record.acts[0].configured_document_ids, [10]);
    assert.deepEqual(record.acts[1].configured_document_ids, [10]);
    assert.equal(record.acts[2].status, 'pending_document_for_this_act');
    assert.equal(plan.consent_operations.length, 1);
    assert(record.pending.includes('FALTA_DOCUMENTO_LITERAL_PARA_UN_ACTO'));
    assert(record.pending.includes('ASOCIACION_LITERAL_PROPUESTA_NO_APLICADA'));
    assert.equal(record.clinical_coverage_verified, false);
});

test('replay is fail-closed on modified requirements/protocols and never overwrites historic snapshots', () => {
    const h = fixture(), plan = prepare(h.input);
    const requirementChanged = clone(h.snapshot); requirementChanged.consent_requirements[0].required = 0;
    assert.equal(replay(plan, requirementChanged).decision, 'existing_requirement_changed_stop');
    const protocolChanged = clone(h.snapshot); protocolChanged.protocols[0].treatment_ids = [100]; protocolChanged.protocols[0].version++;
    assert.equal(replay(plan, protocolChanged).decision, 'protocol_revision_changed_requires_fresh_plan');
    const unrelated = clone(h.snapshot); unrelated.treatments[0].activo = 0;
    assert.equal(replay(plan, unrelated).decision, 'snapshot_changed_requires_fresh_reconciliation');
    assert.deepEqual(plan.historical_patient_snapshots, { exported: false, modified: false, inspected: false });
    const corrupt = clone(plan); corrupt.summary.clinical_coverage_declared_complete = 167;
    assert.throws(() => verify(corrupt, h.input), /BS_DOC_PLAN_CHANGED/);
});

test('fresh reconciliation after the proposed append is idempotent and preserves IDs/content/approval without a second operation', () => {
    const h = fixture(), first = prepare(h.input);
    h.snapshot.consent_requirements.push({ id: 2, ...first.consent_operations[0].values });
    h.protocol.treatment_ids.push(...first.protocol_operations[0].add_treatment_ids);
    h.protocol.version++;
    h.reseal();
    const repeated = prepare(h.input);
    assert.equal(repeated.consent_operations.length, 0);
    assert.equal(repeated.protocol_operations.length, 0);
    assert.equal(repeated.records[0].exact_draft_protocol_references[0].already_linked, true);
    assert.equal(repeated.summary.clinically_approved_protocols_in_inventory, 0);
    assert.equal(repeated.preserved_requirements.length, 2);
    assert.equal(repeated.preserved_protocols[0].id, 14);
});

test('evidence seals, literal quotes and outside-scope bindings are not replaced by name similarity', () => {
    const h = fixture(); h.review.bindings[0].document_quote = 'Este texto inventado no pertenece al documento de origen.';
    assert.throws(() => prepare(h.input), /BS_DOC_EVIDENCE_ARTIFACT_CHANGED/);
    h.reseal(); assert.equal(prepare(h.input).records[0].rejected_evidence.length, 1);
    const other = fixture(); other.review.bindings.push({ ...other.binding(10), source_catalog_key: hash('otra fila') }); other.reseal();
    assert.throws(() => prepare(other.input), /BS_DOC_BINDING_OUTSIDE_EXACT_SCOPE/);
});

test('client original bytes/literal quotation, platform-base review and undocumented origin are visibly different evidence', () => {
    const h = fixture(), version = h.versions[0];
    version.variable_schema.source = { type: 'bsmedical_pdf_library', source_file: 'Ficticio.pdf' };
    h.review.bindings.filter(binding => binding.clinic_template_id === 10).forEach(binding => { binding.version_sha256 = hash(version); });
    h.input.consentSources = [{ file: 'Ficticio.pdf', pdf_sha256: hash('original-ficticio'), text: h.binding(10).document_quote }];
    h.reseal();
    let evidence = prepare(h.input).records[0].consent_links[0].evidence[0];
    assert.equal(evidence.document_origin_status, 'client_pdf_bytes_and_literal_quote_verified');
    assert.equal(evidence.original_pdf_sha256, hash('original-ficticio'));
    h.input.consentSources[0].text = 'Otro acto documental, sólo ficticio.';
    evidence = prepare(h.input).records[0].consent_links[0].evidence[0];
    assert.equal(evidence.document_origin_status, 'client_pdf_reference_pending_literal_original_check');
    version.variable_schema.source = { type: 'clinicaclick_catalog', note: 'Base ficticia, requiere revisión.' };
    h.review.bindings.filter(binding => binding.clinic_template_id === 10).forEach(binding => { binding.version_sha256 = hash(version); });
    h.reseal();
    const record = prepare(h.input).records[0];
    assert.equal(record.consent_links[0].evidence[0].document_origin_status, 'platform_base_requires_medical_legal_review');
    assert(record.pending.includes('PLANTILLA_BASE_CLINICACLICK_NO_ES_DOCUMENTO_LITERAL_DEL_CLIENTE_REQUIERE_REVISION'));
    assert.equal(record.clinical_coverage_verified, false);
});

test('human spreadsheet has one record per exact treatment, concrete Spanish pending explanations and no inferred approval', () => {
    const h = fixture(), plan = prepare(h.input), text = csv(plan);
    const rows = require('../../lib/cliniccloud-import/csv').parseCsv(text);
    assert.equal(rows.length, 167);
    assert.match(rows[0].values['Qué falta resolver'], /confirmar qué actos clínicos/);
    assert.equal(rows[0].values['Aprobado clínicamente'], 'No se concede aprobación con este informe');
    assert.match(rows[0].values['Asociación de protocolo propuesta'], /14, páginas 12, 13; borrador propuesto sin aplicar/);
});

test('human spreadsheet rejects a corrupted proposal and escapes spreadsheet formulas', () => {
    const h = fixture(), plan = prepare(h.input);
    plan.records[0].name = '=FICTICIO()';
    assert.throws(() => csv(plan), /BS_DOC_PLAN_CHANGED/);
    const { plan_sha256, ...body } = plan;
    const rows = require('../../lib/cliniccloud-import/csv').parseCsv(csv(seal(body, 'plan_sha256')));
    assert.equal(rows[0].values.Tratamiento, "'=FICTICIO()");
});

// This harness runs the real package/tablet/care services against in-memory
// models. It does not boot the app, use a connection or contact any provider.
function integrated() {
    const h = fixture(), plan = prepare(h.input), Sequelize = require('sequelize'), Op = Sequelize.Op;
    const state = { packages: [], documents: [], deliveries: [], careEvents: [], patientEvents: [] };
    const requirements = [h.requirement, { ...h.requirement, id: 999 },
        { id: 2, ...plan.consent_operations[0].values }].map(requirement => {
        const template = h.templates.find(template => template.id === requirement.clinic_template_id);
        return { ...requirement, clinicTemplate: { ...template, versions: h.versions.filter(version => version.clinic_template_id === template.id) } };
    });
    const past = new Date(Date.now() - 60 * 60000).toISOString();
    const appointment = { id_cita: 1, paciente_id: 9001, clinica_id: 72, tratamiento_id: 100, inicio: past,
        estado: 'info_confirmada', es_provisional: false, arrived_at: past, care_schedule_start: past,
        paciente: { id_paciente: 9001, nombre: 'Paciente ficticio', clinica_id: 72 },
        clinica: { id_clinica: 72, nombre_clinica: 'Clínica ficticia' },
        tratamiento: { id_tratamiento: 100, nombre: 'Combinado ficticio' }, import_metadata: {} };
    Object.defineProperty(appointment, 'update', { value: async (values, options) => {
        assert(options.transaction); Object.assign(appointment, values); return appointment;
    } });
    const matches = (row, where = {}) => Reflect.ownKeys(where).every(key => {
        const value = where[key];
        if (key === Op.or) return value.some(branch => matches(row, branch));
        if (value && typeof value === 'object') {
            if (value[Op.notIn]) return !value[Op.notIn].includes(row[key]);
            if (value[Op.in]) return value[Op.in].includes(row[key]);
        }
        return value === row[key];
    });
    const db = { Sequelize, sequelize: { transaction: async (options, callback) => {
        if (typeof options === 'function') callback = options;
        return callback({ LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } });
    } }, CitaPaciente: { findByPk: async id => Number(id) === 1 ? appointment : null,
        findOne: async ({ where }) => Number(where.id_cita) === 1 && Number(where.clinica_id) === 72 ? appointment : null },
    Paciente: { findByPk: async () => appointment.paciente }, PacienteClinica: { findOne: async () => null },
    Clinica: { findByPk: async () => ({ ...appointment.clinica, grupoClinicaId: 29 }) },
    Tratamiento: { findAll: async () => [h.snapshot.treatments[0]], findOne: async () => h.snapshot.treatments[0] },
    Usuario: {}, PatientIntakeRequest: { findOne: async () => null },
    ClinicConsentTemplate: {}, ClinicConsentTemplateVersion: { findOne: async ({ where }) => h.versions
        .filter(version => Number(version.clinic_template_id) === Number(where.clinic_template_id)
            && version.status === where.status && version.locale === where.locale)
        .sort((a, b) => b.version - a.version || b.id - a.id)[0] || null },
    ConsentTemplateCatalog: {}, ConsentTemplateCatalogVersion: {},
    TreatmentConsentRequirement: { findAll: async () => requirements },
    ConsentSignaturePackage: {
        findOne: async options => state.packages.find(row => matches(row, options.where)) || null,
        create: async values => { const row = { id: state.packages.length + 1, ...values }; state.packages.push(row); return row; },
        findByPk: async id => {
            const row = state.packages.find(row => row.id === id);
            return row && { ...row, documents: state.documents.filter(doc => doc.package_id === id),
                paciente: appointment.paciente, clinica: appointment.clinica, tratamiento: appointment.tratamiento };
        },
        update: async (values, options) => state.packages.filter(row => matches(row, options.where)).forEach(row => Object.assign(row, values)),
    }, PatientConsentDocument: {
        findOne: async options => state.documents.find(row => matches(row, options.where)) || null,
        findAll: async options => state.documents.filter(row => matches(row, options.where)),
        create: async values => {
            const row = { id: state.documents.length + 1, revoked_at: null, ...values };
            Object.defineProperty(row, 'update', { value: async values => { Object.assign(row, values); return row; } });
            state.documents.push(row); return row;
        },
    }, ConsentDeliveryEvent: {
        findOne: async options => state.deliveries.find(row => matches(row, options.where)) || null,
        create: async values => { const row = { id: state.deliveries.length + 1, ...values }; state.deliveries.push(row); return row; },
    }, AppointmentCareEvent: { create: async values => {
        const row = { id: state.careEvents.length + 1, ...values }; state.careEvents.push(row); return row;
    } },
    PatientOperationalEvent: { create: async values => state.patientEvents.push(values) },
    TreatmentProtocol: {
        findOne: async () => ({ id: 14 }),
        findAll: async () => [{ id: 14, version: 1, status: 'draft' }],
        findAndCountAll: async () => ({ rows: [], count: 0 }),
        count: async () => 1,
    }, TreatmentProtocolRevision: { findAll: async () => [] },
    };
    const load = relative => {
        const filename = path.resolve(__dirname, '../../services', relative), nativeRequire = createRequire(filename), module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
            require: name => name === '../../models' ? db : nativeRequire(name), __dirname: path.dirname(filename),
            process: { env: { JWT_SECRET: 'ficticio-local-only-not-a-runtime-credential' } }, Buffer, console });
        return module.exports;
    };
    const consents = load('consentimientos.service.js'), care = load('appointmentCare.service.js');
    const docs = require('../../services/treatmentDocumentation.service').createTreatmentDocumentationService(db);
    return { h, plan, state, appointment, requirements, consents, care, docs, db,
        prepare: () => consents.createPackageForAppointment(1, { createdBy: 7, triggerSource: 'offline_fixture' }) };
}

test('integrated proposal → package → tablet queues only two effective documents, preserves signed snapshots and permits start only after actual fake signatures', async () => {
    const h = integrated(), before = JSON.stringify(h.appointment);
    const first = await h.prepare();
    assert.equal(first.required_count, 2);
    assert.equal(h.state.documents.length, 2, 'RF shared by EXION and INDIBA is one effective requirement in the same treatment');
    const hashes = h.state.documents.map(document => document.snapshot_hash);
    await h.consents.createTabletSession(first.id, { base_url: 'http://offline-fixture.invalid' });
    await h.consents.createTabletSession(first.id, { base_url: 'http://offline-fixture.invalid' });
    assert.equal(h.state.deliveries.length, 2, 'tablet retry reuses the same documents and queued events');
    assert.equal(JSON.stringify(h.appointment), before);
    await assert.rejects(h.care.record({ appointmentId: 1, clinicId: 72, actorId: 7, action: 'start' }), { code: 'appointment_consent_required' });
    assert.equal(h.state.careEvents.length, 0);
    h.state.documents.forEach(document => { document.status = 'signed'; document.signed_at = new Date(Date.now() - 1000); });
    const signed = h.state.documents.map(document => JSON.stringify(document));
    await h.prepare();
    assert.deepEqual(h.state.documents.map(document => JSON.stringify(document)), signed);
    assert.deepEqual(h.state.documents.map(document => document.snapshot_hash), hashes);
    const started = await h.care.record({ appointmentId: 1, clinicId: 72, actorId: 7, action: 'start' });
    assert(started.care.started_at);
    assert.equal(h.appointment.estado, 'info_confirmada', 'care start does not complete, charge or consume a voucher');
    assert.equal(h.state.careEvents.length, 1);
    assert.equal(h.state.patientEvents.length, 1);
    assert.equal(h.state.deliveries.length, 2, 'care start causes no additional tablet/reminder delivery');
});

test('integrated draft protocol association does not expose its text as approved at appointment start', async () => {
    const h = integrated();
    assert.equal(h.plan.protocol_operations[0].approved, false);
    const context = await h.docs.forAppointment({ clinicId: 72, appointmentId: 1 });
    assert.equal(context.draft_count, 1);
    assert.deepEqual(context.items, []);
    assert.equal(context.persisted_for_appointment, false);
    assert(!JSON.stringify(context).includes('Página ficticia'));
});

test('integrated changed catalogue version never rewrites an already signed effective appointment document', async () => {
    const h = integrated(); await h.prepare();
    h.state.documents.forEach(document => { document.status = 'signed'; document.signed_at = new Date(Date.now() - 1000); });
    const before = h.state.documents.map(document => JSON.stringify(document));
    h.requirements[0].clinicTemplate.versions.push({ ...h.requirements[0].clinicTemplate.versions[0], id: 4000, version: 2,
        body_html: '<p>Documento de catálogo modificado después de la firma ficticia.</p>' });
    await h.prepare();
    assert.equal(h.state.documents.length, 2);
    assert.deepEqual(h.state.documents.map(document => JSON.stringify(document)), before);
});

test('integrated program component documents with distinct frozen treatment/professional contexts are not collapsed by matching template ID', async () => {
    const h = integrated();
    Object.assign(h.appointment, { voucher_id: 8, source_system: 'treatment_program', import_metadata: {
        program_session: { session_id: 15, key: 's1' },
        booking: { phases: [{ key: 'a', doctor_ids: [7] }, { key: 'b', doctor_ids: [8] }] },
    } });
    h.requirements[1].tratamiento_id = 101;
    h.db.Tratamiento.findAll = async () => [h.h.snapshot.treatments[0], h.h.snapshot.treatments[1]];
    h.db.PatientVoucher = { findOne: async () => ({ id: 8 }) };
    h.db.PatientProgramSession = { findOne: async () => ({ snapshot: { treatment_ids: [100, 101],
        phase_treatments: [{ key: 'a', treatment_id: 100 }, { key: 'b', treatment_id: 101 }] } }) };
    h.db.Usuario.findAll = async () => [{ id_usuario: 7, nombre: 'Profesional ficticio A' }, { id_usuario: 8, nombre: 'Profesional ficticio B' }];
    const pack = await h.prepare();
    const radiofrequency = h.state.documents.filter(document => document.clinic_template_id === 10);
    assert.equal(pack.required_count, 3);
    assert.equal(radiofrequency.length, 2, 'same template is not the same effective rendered act/signing context');
    assert.deepEqual(radiofrequency.map(document => document.tratamiento_id).sort(), [100, 101]);
    assert.deepEqual(radiofrequency.map(document => document.snapshot_json.context.profesional.id).sort(), [7, 8]);
    assert.notEqual(radiofrequency[0].snapshot_hash, radiofrequency[1].snapshot_hash);
    await h.prepare(); assert.equal(h.state.documents.length, 3);
});
