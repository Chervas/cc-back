'use strict';

// Offline documentary proposals only. This module deliberately cannot write,
// approve a protocol, create a patient document, sign, or send a tablet session.
const { hash } = require('./adapter');
const { WORKBOOK_SHA, PDF_SOURCES } = require('./catalog-matrix');
const { SUPPORTED_VERSIONS, checkedMatrix, reconcileCatalog } = require('./catalog-preflight');
const { verifyPlan: verifySourcePlan } = require('./catalog-drafts');
const { textOf } = require('./catalog-consent-links');

const VERSION = 'bs-documentation-reconciliation-offline/1';
const fail = code => { throw Error(code); };
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const copy = value => JSON.parse(JSON.stringify(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const pair = row => `${Number(row.tratamiento_id)}:clinic:${Number(row.clinic_template_id)}`;
const latest = versions => [...versions].sort((a, b) => Number(b.version) - Number(a.version) || Number(b.id) - Number(a.id))[0];
const counts = (rows, key) => rows.reduce((out, row) => { const value = key(row); out[value] = (out[value] || 0) + 1; return out; }, {});

function inputs(matrixRows, matrixFileSha256, preflight, sourcePlan) {
    const concepts = checkedMatrix(matrixRows);
    if (!SUPPORTED_VERSIONS.includes(preflight?.version) || preflight.target !== 'crm' || preflight.mode !== 'read_only'
        || preflight.group_id !== 29 || !sha(matrixFileSha256) || matrixFileSha256 !== preflight.matrix_file_sha256
        || !preflight.snapshot || hash(preflight.snapshot) !== preflight.snapshot_sha256
        || !Number.isFinite(Date.parse(preflight.created_at))) fail('BS_DOC_PREFLIGHT_INVALID');
    const policies = { database_written: false, patient_rows_exported: false, application_bootstrapped: false,
        reminders_sent: false, protocols_approved: false, treatments_activated: false, existing_entitlements_unchanged: true };
    if (Object.entries(policies).some(([key, value]) => preflight.policy?.[key] !== value)
        || preflight.snapshot.triggers?.length || preflight.snapshot.clinics?.length !== 2
        || ![66, 72].every(id => preflight.snapshot.clinics.some(row => Number(row.id_clinica) === id && Number(row.grupoClinicaId) === 29))) fail('BS_DOC_SCOPE_INVALID');
    const reconciled = reconcileCatalog(matrixRows, preflight.snapshot);
    if (reconciled.records.some(row => row.status !== 'exact_existing_source')
        || new Set(reconciled.records.map(row => row.treatment_id)).size !== 167
        || hash(reconciled.records) !== hash(preflight.reconciliation?.records)) fail('BS_DOC_EXACT_IDENTITY_REQUIRED');
    verifySourcePlan(sourcePlan);
    if (sourcePlan.workbook_sha256 !== WORKBOOK_SHA) fail('BS_DOC_SOURCE_WORKBOOK_CHANGED');
    const sources = new Map();
    for (const concept of concepts) {
        const candidates = sourcePlan.rows.filter(row => row.source_catalog_key === concept.matrix_key);
        if (candidates.length !== 1) fail('BS_DOC_SOURCE_ROW_NOT_UNIQUE');
        const source = candidates[0], ref = json(concept.source_references_json).find(row => row.file_sha256 === WORKBOOK_SHA);
        if (source.proposed_code !== concept.code || source.clinic_id !== (concept.clinic === 'BS Capilar' ? 66 : 72)
            || source.provenance.file_sha256 !== ref.file_sha256 || source.provenance.sheet !== ref.sheet
            || Number(source.provenance.source_row) !== Number(ref.source_row) || source.provenance.row_sha256 !== ref.row_sha256
            || hash(source.raw_cells) !== ref.row_sha256 || source.raw_cells.B !== source.name
            || hash([source.sheet, source.category, source.name]) !== concept.matrix_key) fail('BS_DOC_SOURCE_LITERAL_CHANGED');
        sources.set(concept.matrix_key, source);
    }
    return { concepts, records: reconciled.records, sources };
}

function artifactBindings(artifacts) {
    if (!Array.isArray(artifacts) || artifacts.length > 20) fail('BS_DOC_EVIDENCE_ARTIFACTS_INVALID');
    const result = [];
    for (const artifact of artifacts) {
        if (!artifact || typeof artifact.key !== 'string' || !sha(artifact.document_sha256)
            || hash(artifact.document) !== artifact.document_sha256) fail('BS_DOC_EVIDENCE_ARTIFACT_CHANGED');
        const pkg = artifact.document, review = pkg.review || pkg;
        if (pkg.review) {
            const { package_sha256, ...body } = pkg;
            if (hash(body) !== package_sha256 || hash(pkg.review) !== pkg.review_sha256
                || hash(pkg.before) !== pkg.before_sha256) fail('BS_DOC_HISTORICAL_PACKAGE_CHANGED');
        }
        if (review.version !== 1 || !sha(review.plan_sha256)
            || !['inactive_draft_documentary_associations', 'exact_documentary_reconciliation'].includes(review.scope)
            || review.clinical_approval === true || review.legal_approval === true
            || !Array.isArray(review.bindings) || review.bindings.length > 250) fail('BS_DOC_EVIDENCE_REVIEW_INVALID');
        for (const binding of review.bindings) result.push({ binding, artifact_key: artifact.key,
            artifact_sha256: artifact.document_sha256, historical_plan_sha256: review.plan_sha256 });
    }
    return result;
}

function checkBinding({ binding, artifact_key, artifact_sha256, historical_plan_sha256 }, record, source, snapshot, consentSources) {
    const reasons = [];
    const template = snapshot.consent_templates.find(row => Number(row.id) === Number(binding.clinic_template_id));
    const version = template && latest(snapshot.consent_versions.filter(row => Number(row.clinic_template_id) === Number(template.id)));
    if (!template || Number(template.clinic_id) !== record.clinic_id || template.purpose !== 'clinical'
        || template.status !== 'active' || /^DEMO\b/i.test(template.name)
        || !['hard', 'soft', 'optional'].includes(template.blocking_policy)) reasons.push('PLANTILLA_CLINICA_NO_VALIDA_EN_ESTA_CLINICA');
    if (!sha(binding.template_sha256) || !template || hash(template) !== binding.template_sha256) reasons.push('PLANTILLA_CAMBIADA_DESDE_LA_REVISION');
    if (!version || version.status !== 'published' || version.locale !== 'es' || !textOf(version.body_html)
        || Number(version.id) !== Number(binding.version_id) || !sha(binding.version_sha256)
        || hash(version) !== binding.version_sha256) reasons.push('VERSION_EFECTIVA_CAMBIADA_O_NO_PUBLICADA');
    if (typeof binding.source_quote !== 'string' || binding.source_quote.length < 4
        || ![source.category, source.name, source.detail].join(' ').includes(binding.source_quote)
        || typeof binding.document_quote !== 'string' || binding.document_quote.length < 20
        || !version || !textOf(version.body_html).includes(binding.document_quote)
        || typeof binding.reason !== 'string' || binding.reason.trim().length < 30) reasons.push('FALTA_EVIDENCIA_LITERAL_DEL_ACTO_Y_DOCUMENTO');
    const documentSource = json(version?.variable_schema || {})?.source || null;
    const original = documentSource?.type === 'bsmedical_pdf_library'
        ? consentSources.find(document => document.file === documentSource.source_file && sha(document.pdf_sha256)
            && typeof document.text === 'string') : null;
    const originalQuoteVerified = !!original && typeof binding.document_quote === 'string'
        && textOf(original.text).includes(binding.document_quote);
    const authority = documentSource?.type === 'clinicaclick_catalog' ? 'platform_base_requires_medical_legal_review'
        : documentSource?.type === 'bsmedical_pdf_library' ? originalQuoteVerified
            ? 'client_pdf_bytes_and_literal_quote_verified' : 'client_pdf_reference_pending_literal_original_check'
            : 'document_origin_not_recorded';
    return { verified: reasons.length === 0, pending_reasons: reasons,
        evidence: { artifact_key, artifact_sha256, historical_plan_sha256, source_catalog_key: record.matrix_key,
            source: copy(source.provenance), source_quote: binding.source_quote || null,
            clinic_template_id: Number(binding.clinic_template_id), template_name: template?.name || null,
            template_sha256: binding.template_sha256 || null, version_id: Number(binding.version_id),
            version_sha256: binding.version_sha256 || null, document_quote: binding.document_quote || null,
            reason: binding.reason || null, source_document: documentSource,
            document_origin_status: authority, original_pdf_sha256: original?.pdf_sha256 || null,
            original_document_quote_verified: originalQuoteVerified,
            clinical_approval: false, legal_approval: false, patient_signature_inferred: false } };
}

function checkedComposition(review, records, sources) {
    if (!review) return new Map();
    const { review_sha256, ...body } = review;
    if (review.version !== 1 || review.scope !== 'literal_documentary_act_coverage' || hash(body) !== review_sha256
        || review.clinical_approval !== false || review.legal_approval !== false
        || !Array.isArray(review.concepts) || review.concepts.length > 167) fail('BS_DOC_COMPOSITION_REVIEW_INVALID');
    const result = new Map();
    for (const concept of review.concepts) {
        const source = sources.get(concept.matrix_key);
        if (!records.some(row => row.matrix_key === concept.matrix_key) || !source || result.has(concept.matrix_key)
            || !['individual', 'combined'].includes(concept.kind) || !Array.isArray(concept.acts)
            || !concept.acts.length || concept.acts.length > 20
            || (concept.kind === 'individual' && concept.acts.length !== 1)
            || (concept.kind === 'combined' && concept.acts.length < 2)
            || new Set(concept.acts.map(act => act.key)).size !== concept.acts.length) fail('BS_DOC_ACT_DEFINITION_INVALID');
        for (const act of concept.acts) {
            if (!/^[a-z][a-z0-9_]{0,63}$/.test(act.key) || typeof act.label !== 'string' || !act.label.trim()
                || typeof act.source_quote !== 'string' || act.source_quote.length < 4
                || ![source.category, source.name, source.detail].join(' ').includes(act.source_quote)
                || !Array.isArray(act.document_bindings) || act.document_bindings.some(binding => !positive(binding.clinic_template_id)
                    || typeof binding.document_quote !== 'string' || binding.document_quote.length < 20)) fail('BS_DOC_ACT_LITERAL_EVIDENCE_REQUIRED');
        }
        result.set(concept.matrix_key, copy(concept));
    }
    return result;
}

function protocolReferences(record, treatment, protocols, manualSources) {
    const reference = json(treatment.clinical_config)?.source_corporal_profile;
    if (!reference) return { links: [], pending: 'NO_HAY_REFERENCIA_EXACTA_A_PROTOCOLO_POR_ACTO' };
    if (!sha(reference.pdf_sha256) || !Array.isArray(reference.pages) || !reference.pages.length
        || reference.pages.some(page => !Number.isSafeInteger(page) || page < 1)) return { links: [], pending: 'REFERENCIA_DOCUMENTAL_DE_PROTOCOLO_INCOMPLETA' };
    const candidates = protocols.filter(protocol => Number(protocol.clinic_id) === record.clinic_id
        && protocol.kind === 'protocol' && String(protocol.source).includes(`:sha256:${reference.pdf_sha256};`)
        && reference.pages.every(page => new RegExp(`^## Página ${page} del PDF\\r?$`, 'm').test(protocol.content || '')));
    if (candidates.length !== 1) return { links: [], pending: 'PROTOCOLO_LITERAL_NO_UNICO_POR_HASH_Y_PAGINAS' };
    const protocol = candidates[0];
    const manual = manualSources.find(source => source.sha256 === reference.pdf_sha256
        && PDF_SOURCES.some(spec => spec.role === 'manual' && spec.sha256 === source.sha256 && spec.file === source.file)
        && Array.isArray(source.pages));
    if (!manual || !reference.pages.every(page => {
        const literal = new RegExp(`^## Página ${page} del PDF\\r?\\n\\r?\\n\u0060\u0060\u0060pdf-text\\r?\\n([\\s\\S]*?)\\r?\\n\u0060\u0060\u0060`, 'm').exec(protocol.content || '')?.[1];
        return typeof manual.pages[page - 1] === 'string' && literal === manual.pages[page - 1];
    })) return { links: [], pending: 'PAGINAS_DEL_PROTOCOLO_NO_CONTRASTADAS_CON_EL_PDF_ORIGINAL' };
    // Only a draft may receive an association proposal here. An approved
    // revision needs its own reviewed update; never reuse its approval stamp.
    if (protocol.status !== 'draft' || protocol.approved_by || protocol.approved_at) return { links: [], pending: 'ASOCIACION_A_PROTOCOLO_APROBADO_REQUIERE_NUEVA_REVISION' };
    return { links: [{ protocol_id: Number(protocol.id), expected_version: Number(protocol.version),
        before_sha256: hash(protocol), source_pdf_sha256: reference.pdf_sha256, pages: copy(reference.pages),
        literal_page_sha256: reference.pages.map(page => hash(manual.pages[page - 1])),
        treatment_id: record.treatment_id, already_linked: json(protocol.treatment_ids).map(Number).includes(record.treatment_id),
        protocol_status: 'draft', available_at_care_start: false,
        explanation: 'El tratamiento ya conserva este PDF y estas páginas exactas como procedencia. Se propone asociar el borrador; no aprobarlo.' }], pending: null };
}

function prepareDocumentationReconciliation({ matrixRows, matrixFileSha256, preflight, sourcePlan,
    evidenceArtifacts = [], coverageReview = null, manualSources = [], consentSources = [] }) {
    const { records, sources } = inputs(matrixRows, matrixFileSha256, preflight, sourcePlan);
    const snapshot = preflight.snapshot, bindings = artifactBindings(evidenceArtifacts);
    if (bindings.some(row => !sources.has(row.binding.source_catalog_key))) fail('BS_DOC_BINDING_OUTSIDE_EXACT_SCOPE');
    const composition = checkedComposition(coverageReview, records, sources);
    const consentOperations = [], protocolOperations = [], report = [], used = new Set();
    for (const record of records) {
        const treatment = snapshot.treatments.find(row => Number(row.id_tratamiento) === record.treatment_id);
        const source = sources.get(record.matrix_key);
        const requirements = snapshot.consent_requirements.filter(row => Number(row.tratamiento_id) === record.treatment_id);
        const relevant = bindings.filter(row => row.binding.source_catalog_key === record.matrix_key);
        const evaluated = relevant.map(row => ({ ...checkBinding(row, record, source, snapshot, consentSources), binding: row.binding }));
        const consentLinks = requirements.map(requirement => {
            const matches = evaluated.filter(row => Number(row.binding.clinic_template_id) === Number(requirement.clinic_template_id));
            const configured = (requirement.clinica_id == null || Number(requirement.clinica_id) === record.clinic_id)
                && requirement.requirement_scope === 'treatment' && requirement.condition_key == null
                && requirement.catalog_template_id == null;
            const verified = configured ? matches.filter(row => row.verified) : [];
            return { requirement_id: Number(requirement.id), requirement_sha256: hash(requirement),
                clinic_template_id: requirement.clinic_template_id, catalog_template_id: requirement.catalog_template_id,
                required: Boolean(Number(requirement.required)), blocking_policy: requirement.blocking_policy,
                status: verified.length ? 'literal_link_verified_not_clinically_approved' : 'existing_link_preserved_pending_literal_review',
                effective_document_key: verified.length ? `${record.treatment_id}:clinic:${requirement.clinic_template_id}:version:${verified[0].evidence.version_id}` : null,
                evidence: verified.map(row => row.evidence), pending_reasons: verified.length ? []
                    : [...new Set(!configured ? ['REQUISITO_CON_AMBITO_O_CONDICION_NO_VERIFICADA']
                        : matches.length ? matches.flatMap(row => row.pending_reasons) : ['ENLACE_ACTUAL_SIN_REVISION_LITERAL_VERIFICABLE'])] };
        });
        for (const row of evaluated.filter(row => row.verified)) {
            const key = `${record.treatment_id}:clinic:${row.binding.clinic_template_id}`;
            if (used.has(key)) continue; // repeated reviewed proof is not a second effective requirement
            used.add(key);
            if (requirements.some(requirement => pair(requirement) === key)) continue;
            const template = snapshot.consent_templates.find(template => Number(template.id) === Number(row.binding.clinic_template_id));
            const values = { tratamiento_id: record.treatment_id, clinica_id: record.clinic_id,
                clinic_template_id: Number(template.id), catalog_template_id: null, requirement_scope: 'treatment',
                condition_key: null, required: 1, blocking_policy: template.blocking_policy,
                sort_order: Math.max(-1, ...requirements.map(row => Number(row.sort_order))) + 1
                    + consentOperations.filter(operation => operation.treatment_id === record.treatment_id).length };
            consentOperations.push({ kind: 'propose_append_exact_consent_requirement', treatment_id: record.treatment_id,
                values, values_sha256: hash(values), treatment_before_sha256: hash(treatment), evidence: row.evidence });
        }
        const reviewed = composition.get(record.matrix_key);
        const acts = reviewed?.acts.map(act => {
            const coverage = act.document_bindings.filter(binding => evaluated.some(row => row.verified
                && Number(row.binding.clinic_template_id) === Number(binding.clinic_template_id)
                && textOf(snapshot.consent_versions.find(version => Number(version.id) === row.evidence.version_id)?.body_html).includes(binding.document_quote)));
            return { key: act.key, label: act.label, source_quote: act.source_quote,
                covered_by_document_ids: [...new Set(coverage.map(binding => Number(binding.clinic_template_id)))],
                configured_document_ids: [...new Set(coverage.filter(binding => consentLinks.some(link =>
                    link.status === 'literal_link_verified_not_clinically_approved'
                        && Number(link.clinic_template_id) === Number(binding.clinic_template_id))).map(binding => Number(binding.clinic_template_id)))],
                status: coverage.length ? 'literal_documentary_scope_verified_not_approved' : 'pending_document_for_this_act' };
        }) || [];
        const protocols = protocolReferences(record, treatment, snapshot.protocols, manualSources);
        for (const link of protocols.links.filter(link => !link.already_linked)) {
            let operation = protocolOperations.find(operation => operation.protocol_id === link.protocol_id);
            if (!operation) {
                operation = { kind: 'propose_append_draft_protocol_associations', protocol_id: link.protocol_id,
                    expected_version: link.expected_version, before_sha256: link.before_sha256,
                    add_treatment_ids: [], evidence: [], approved: false, available_at_care_start: false };
                protocolOperations.push(operation);
            }
            operation.add_treatment_ids.push(record.treatment_id); operation.evidence.push(link);
        }
        report.push({ matrix_key: record.matrix_key, code: record.code, treatment_id: record.treatment_id,
            clinic_id: record.clinic_id, name: record.current_name, source_identity: copy(source.provenance),
            composition_kind: reviewed?.kind || 'not_clinically_decomposed', acts,
            consent_links: consentLinks, proposed_consent_links: consentOperations.filter(operation => operation.treatment_id === record.treatment_id),
            rejected_evidence: evaluated.filter(row => !row.verified).map(({ binding, ...row }) => row),
            protocol_links_preserved: record.protocol_ids, exact_draft_protocol_references: protocols.links,
            protocol_pending: protocols.pending,
            clinical_coverage_verified: false,
            explanation: reviewed?.kind === 'combined'
                ? 'Una cita combinada necesita cubrir cada acto declarado. Un mismo documento efectivo se pide una sola vez; no se deduce que cubra las otras técnicas por compartir nombre, máquina o cita.'
                : reviewed?.kind === 'individual'
                    ? 'Se contrasta el acto individual con la versión literal de su documento. Asociación, aprobación del protocolo y firma del paciente son comprobaciones distintas.'
                    : 'Se conserva el concepto individual del catálogo de origen, sin inventar su composición clínica. Los enlaces literales están comprobados donde hay evidencia; esto no acredita que todas sus técnicas estén cubiertas.',
            pending: [ ...(requirements.length ? [] : ['NO_HAY_CONSENTIMIENTO_CLINICO_ASOCIADO_NO_SE_INFIERE_EXENCION']),
                ...(consentOperations.some(operation => operation.treatment_id === record.treatment_id) ? ['ASOCIACION_LITERAL_PROPUESTA_NO_APLICADA'] : []),
                ...(evaluated.some(row => row.verified && row.evidence.document_origin_status === 'platform_base_requires_medical_legal_review')
                    ? ['PLANTILLA_BASE_CLINICACLICK_NO_ES_DOCUMENTO_LITERAL_DEL_CLIENTE_REQUIERE_REVISION'] : []),
                ...(evaluated.some(row => row.verified && row.evidence.document_origin_status === 'document_origin_not_recorded')
                    ? ['PROCEDENCIA_DOCUMENTAL_DE_LA_PLANTILLA_NO_GUARDADA'] : []),
                ...(evaluated.some(row => row.verified && row.evidence.document_origin_status === 'client_pdf_reference_pending_literal_original_check')
                    ? ['CITA_DE_LA_PLANTILLA_PENDIENTE_DE_CONTRASTAR_CON_PDF_ORIGINAL'] : []),
                ...(!reviewed ? ['FALTA_REVISION_EXPLICITA_DE_ACTOS_Y_COBERTURA'] : acts.some(act => act.status === 'pending_document_for_this_act') ? ['FALTA_DOCUMENTO_LITERAL_PARA_UN_ACTO'] : []),
                ...(record.protocol_ids.length || protocols.links.length ? ['PROTOCOLO_REQUIERE_APROBACION_Y_SNAPSHOT_DE_REVISION'] : [protocols.pending]),
            ].filter(Boolean) });
    }
    const body = { version: VERSION, target: 'crm', mode: 'offline_documentary_proposal', group_id: 29,
        created_at: preflight.created_at, matrix_file_sha256: matrixFileSha256, snapshot_sha256: preflight.snapshot_sha256,
        source_plan_sha256: sourcePlan.plan_sha256, evidence_artifacts: evidenceArtifacts.map(row => ({ key: row.key, document_sha256: row.document_sha256 })),
        coverage_review_sha256: coverageReview?.review_sha256 || null,
        preserved_requirements: snapshot.consent_requirements.map(row => ({ id: Number(row.id), before_sha256: hash(row) })),
        preserved_protocols: snapshot.protocols.map(row => ({ id: Number(row.id), before_sha256: hash(row) })),
        // No patient rows are present in this inventory. Preservation is a
        // command contract, not an assertion that historical signatures were inspected.
        historical_patient_snapshots: { exported: false, modified: false, inspected: false },
        consumer_contract: {
            consent_association: { model: 'TreatmentConsentRequirement', scope: 'treatment',
                exact_key: 'tratamiento_id + clinic_template_id',
                explanation: 'La asociación pertenece al tratamiento real, no al nombre de una técnica, a un programa parecido ni a un formulario de alta.' },
            protocol_association: { model: 'TreatmentProtocol', route: 'treatmentDocumentation.save',
                required_command: ['authenticated_actor', 'clinic_id', 'expected_version', 'existing_treatment_ids_plus_explicit_additions', 'status_draft'],
                explanation: 'Guardar asociaciones crea una revisión de borrador. Sólo una aprobación clínica explícita posterior permite servir su snapshot aprobado al iniciar.' },
            appointment_resolution: { source: 'appointment.tratamiento_id_or_server_verified_purchased_program_session.treatment_ids',
                booking_phases_are_not_clinical_act_evidence: true,
                explanation: 'Los consumidores actuales no obtienen consentimientos por la lista de máquinas o fases de agenda. Un combinado nuevo necesita una composición documental explícita antes de conectarlo a esos consumidores.' },
            effective_document: { duplicate_same_treatment_requirement_reuses_document: true,
                different_treatment_or_professional_context_must_not_be_collapsed: true,
                existing_signed_snapshot_is_authoritative: true,
                explanation: 'Se deduplica el requisito efectivo de la misma cita y contexto. Compartir plantilla no autoriza mezclar actos, profesionales o snapshots firmados distintos.' },
            known_integration_gaps: [
                'El inicio actual comprueba requisitos clínicos obligatorios configurados; cero requisitos no es una revisión clínica ni prueba de exención.',
                'La biblioteca de inicio sirve revisiones aprobadas del catálogo actual; no congela por sí sola el protocolo en la cita.',
                'El informe no revisa firmas históricas ni sustituye documentos ya preparados. La prueba integrada usa únicamente modelos ficticios en memoria.',
            ],
        },
        consent_operations: consentOperations, protocol_operations: protocolOperations, records: report,
        summary: { exact_treatments: report.length, current_requirements: report.reduce((n, row) => n + row.consent_links.length, 0),
            treatments_with_current_requirements: report.filter(row => row.consent_links.length).length,
            verified_literal_requirement_links: report.flatMap(row => row.consent_links).filter(row => row.status === 'literal_link_verified_not_clinically_approved').length,
            pending_literal_requirement_links: report.flatMap(row => row.consent_links).filter(row => row.status !== 'literal_link_verified_not_clinically_approved').length,
            verified_link_document_origins: counts(report.flatMap(row => row.consent_links).filter(row => row.evidence.length),
                row => row.evidence[0].document_origin_status),
            treatments_without_requirement: report.filter(row => !row.consent_links.length).length,
            composition_review: counts(report, row => row.composition_kind),
            proposed_consent_links: consentOperations.length, proposed_draft_protocol_links: protocolOperations.reduce((n, row) => n + row.add_treatment_ids.length, 0),
            clinically_approved_protocols_in_inventory: snapshot.protocols.filter(row => row.status === 'approved' && row.approved_at && row.approved_by).length,
            clinical_coverage_declared_complete: 0, database_writes: 0 },
        policy: { append_only_associations: true, same_name_is_not_evidence: true, clinical_approval: false,
            legal_approval: false, protocols_approved: false, patient_documents_created: false, signatures_inferred: false,
            initial_form_is_not_consent: true, fiscal_or_status_changes: false, reminders_or_tablet_sent: false,
            applicator_present: false, recheck_fresh_snapshot_before_any_future_apply: true,
            effective_document_dedupe_scope: 'same_treatment_act_template_version_and_rendered_signing_context_only' } };
    return { ...body, plan_sha256: hash(body) };
}

function verifyDocumentationReconciliation(plan, options) {
    const expected = prepareDocumentationReconciliation(options);
    if (hash(plan) !== hash(expected)) fail('BS_DOC_PLAN_CHANGED');
    return true;
}

function assessDocumentationReplay(plan, currentSnapshot) {
    const { plan_sha256, ...body } = plan;
    if (plan.version !== VERSION || hash(body) !== plan_sha256) fail('BS_DOC_PLAN_CHANGED');
    if (hash(currentSnapshot) === plan.snapshot_sha256) return { decision: 'original_snapshot_matches_proposal', write_permitted: false };
    for (const row of plan.preserved_requirements) {
        const current = currentSnapshot.consent_requirements.find(item => Number(item.id) === row.id);
        if (!current || hash(current) !== row.before_sha256) return { decision: 'existing_requirement_changed_stop', write_permitted: false };
    }
    for (const row of plan.preserved_protocols) {
        const current = currentSnapshot.protocols.find(item => Number(item.id) === row.id);
        if (!current || hash(current) !== row.before_sha256) return { decision: 'protocol_revision_changed_requires_fresh_plan', write_permitted: false };
    }
    // A protocol association save creates a new revision/timestamp. Its receipt
    // and subsequent fresh inventory are needed, never inferred from extra IDs.
    return { decision: 'snapshot_changed_requires_fresh_reconciliation', write_permitted: false };
}

function documentationReconciliationCsv(plan) {
    const { plan_sha256, ...body } = plan;
    if (plan.version !== VERSION || hash(body) !== plan_sha256) fail('BS_DOC_PLAN_CHANGED');
    const reasons = {
        NO_HAY_CONSENTIMIENTO_CLINICO_ASOCIADO_NO_SE_INFIERE_EXENCION: 'No tiene consentimiento clínico asociado. No se deduce que esté exento.',
        FALTA_REVISION_EXPLICITA_DE_ACTOS_Y_COBERTURA: 'Falta confirmar qué actos clínicos contiene y qué documento cubre cada uno.',
        FALTA_DOCUMENTO_LITERAL_PARA_UN_ACTO: 'Alguno de sus actos no tiene documento literal acreditado.',
        ASOCIACION_LITERAL_PROPUESTA_NO_APLICADA: 'Hay una asociación documental propuesta, todavía sin aplicar.',
        PROTOCOLO_REQUIERE_APROBACION_Y_SNAPSHOT_DE_REVISION: 'El protocolo sigue pendiente de aprobación clínica y de su revisión congelada.',
        NO_HAY_REFERENCIA_EXACTA_A_PROTOCOLO_POR_ACTO: 'No hay referencia exacta de este tratamiento a un protocolo concreto.',
        PLANTILLA_BASE_CLINICACLICK_NO_ES_DOCUMENTO_LITERAL_DEL_CLIENTE_REQUIERE_REVISION: 'Usa una plantilla base de Clinicaclick, no el PDF literal del cliente; necesita revisión médica y legal.',
        PROCEDENCIA_DOCUMENTAL_DE_LA_PLANTILLA_NO_GUARDADA: 'La plantilla no guarda su documento de origen.',
        CITA_DE_LA_PLANTILLA_PENDIENTE_DE_CONTRASTAR_CON_PDF_ORIGINAL: 'El texto de la plantilla no se ha contrastado literalmente con el PDF original.',
        ENLACE_ACTUAL_SIN_REVISION_LITERAL_VERIFICABLE: 'La asociación ya existe, pero falta su revisión literal trazable.',
        REQUISITO_CON_AMBITO_O_CONDICION_NO_VERIFICADA: 'El ámbito o condición del requisito necesita revisión.',
    };
    const cell = value => {
        let text = String(value ?? '');
        if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // spreadsheet formula injection
        return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ['Clínica', 'ID tratamiento', 'Código', 'Tratamiento', 'Composición revisada',
        'Documentos actuales y versión comprobada', 'Procedencia del documento', 'Protocolo actual',
        'Asociación de protocolo propuesta', 'Qué falta resolver', 'Explicación', 'Aprobado clínicamente'];
    const rows = plan.records.map(record => [record.clinic_id === 66 ? 'BS Capilar' : 'BS Medical', record.treatment_id,
        record.code, record.name, record.composition_kind === 'combined' ? 'Combinado: actos declarados'
            : record.composition_kind === 'individual' ? 'Individual: acto declarado' : 'Pendiente de revisión explícita de actos',
        record.consent_links.map(link => link.evidence.length ? link.evidence.map(evidence =>
            `${evidence.template_name} (plantilla ${evidence.clinic_template_id}, versión ${evidence.version_id}); vínculo literal contrastado, no aprobación`).join(' | ')
            : `Plantilla ${link.clinic_template_id || link.catalog_template_id}; asociación conservada, evidencia pendiente`).join(' | ') || 'Ningún requisito asociado',
        [...new Set(record.consent_links.flatMap(link => link.evidence.map(evidence => evidence.document_origin_status === 'client_pdf_bytes_and_literal_quote_verified'
            ? `PDF del cliente: ${evidence.source_document.source_file}; bytes y cita literal comprobados`
            : evidence.document_origin_status === 'platform_base_requires_medical_legal_review' ? 'Plantilla base Clinicaclick: revisión médica/legal pendiente'
                : evidence.document_origin_status === 'document_origin_not_recorded' ? 'Origen documental no guardado'
                    : 'PDF de origen pendiente de contraste literal')))].join(' | '),
        record.protocol_links_preserved.join(', ') || 'Sin asociación actual',
        record.exact_draft_protocol_references.map(link => `${link.protocol_id}, páginas ${link.pages.join(', ')}; borrador ${link.already_linked ? 'ya asociado' : 'propuesto sin aplicar'}`).join(' | '),
        [...record.pending.map(code => reasons[code] || code), ...record.consent_links.flatMap(link => link.pending_reasons.map(code => reasons[code] || code))].join(' | '),
        record.explanation, 'No se concede aprobación con este informe',
    ]);
    return `\uFEFF${[header, ...rows].map(row => row.map(cell).join(';')).join('\r\n')}\r\n`;
}

module.exports = { VERSION, prepareDocumentationReconciliation, verifyDocumentationReconciliation, assessDocumentationReplay,
    documentationReconciliationCsv, validatePinnedTreatmentSources: inputs };
