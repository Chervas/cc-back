'use strict';
const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const { fail, sha256, digest, getCatalog } = require('../legal/catalog');
const { STAFF_ROLES } = require('../lib/role-helpers');
const DECLARATION_TEXT = 'Declaro que soy titular o representante con facultades suficientes para vincular a la entidad identificada de esta clínica y aceptar este documento en su nombre.';
const DECLARATION = Object.freeze({ version: 'clinic-representation-v1', text: DECLARATION_TEXT, sha256: sha256(DECLARATION_TEXT) });
const positiveId = value => ['string', 'number'].includes(typeof value) && /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= 2147483647 ? Number(value) : null;
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const plain = row => row?.toJSON ? row.toJSON() : row;
function contractingEntity(clinic) {
    const fiscal = clinic.datos_fiscales_clinica || {};
    const same = fiscal.billing_same_as_clinic === true;
    return {
        legalName: text(fiscal.denominacion_social, 255), taxId: text(fiscal.cif_nif, 64),
        address: text(same ? clinic.direccion : fiscal.direccion_facturacion, 512),
        postalCode: text(same ? clinic.codigo_postal : fiscal.codigo_postal_facturacion, 32),
        city: text(same ? clinic.ciudad : fiscal.ciudad_facturacion, 128),
        province: text(same ? clinic.provincia : fiscal.provincia_facturacion, 128),
        country: text(same ? clinic.pais : fiscal.pais_facturacion, 128),
    };
}
const entityComplete = entity => Boolean(entity.legalName && entity.taxId && entity.address);
const entityHash = entity => sha256(JSON.stringify(entity));
function requireActor(req) {
    const actorId = positiveId(req.userData?.userId);
    if (!actorId) throw fail('auth_required', 401);
    if (req.authDelegation || req.authSession?.kind === 'delegated') throw fail('delegated_operation_requires_own_session', 403);
    return actorId;
}
function authContext(req, registration = false) {
    const sessionRef = text(req.authSession?.id, 128);
    return { method: registration ? 'account_registration' : sessionRef ? 'managed_session' : 'authenticated_session', ...(sessionRef ? { sessionRef } : {}) };
}
function actorFields(user) {
    const name = [text(user.nombre, 128), text(user.apellidos, 128)].filter(Boolean).join(' ').slice(0, 255);
    const email = text(user.email_usuario, 254);
    if (!name || !email) throw fail('legal_actor_identity_incomplete', 409);
    return { actor_user_id: Number(user.id_usuario), actor_name: name, actor_email: email };
}
async function revalidateOwnSession(req, transaction) {
    const sessions = require('./accessSession.service');
    try {
        const decoded = await sessions.verifyNormal(sessions.bearer(req.headers?.authorization));
        if (decoded.authDelegation || Number(decoded.userId) !== Number(req.userData?.userId)
            || req.authSession?.id && decoded.jti !== req.authSession.id) throw fail('legal_session_changed', 401);
        if (decoded.sessionVersion && sessions.settings().mode === 'enforce') {
            await sessions.verifyNormalReference({ userId: decoded.userId, sessionRef: decoded.jti, expiresAt: new Date(decoded.exp * 1000) }, { transaction });
        }
    } catch (error) {
        if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) throw fail('legal_session_changed', 401);
        throw error;
    }
}
function createLegalAcceptanceService({ db, catalog = getCatalog(), now = () => new Date(), uuid = randomUUID, revalidateAuth = revalidateOwnSession }) {
    function parseScope(input) {
        if (input?.scopeType !== 'clinic' || !positiveId(input.scopeId)) throw fail('legal_clinic_scope_required');
        return { scopeType: 'clinic', scopeId: positiveId(input.scopeId) };
    }
    async function scopeAccess(actorId, scopeId, transaction) {
        const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
        const clinic = plain(await db.Clinica.findByPk(scopeId, { ...options, raw: true }));
        if (!clinic) throw fail('legal_scope_forbidden', 403);
        const membership = plain(await db.UsuarioClinica.findOne({ ...options, raw: true, where: {
            id_usuario: actorId, id_clinica: scopeId, rol_clinica: { [Op.in]: STAFF_ROLES },
            [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }],
        } }));
        if (!membership) throw fail('legal_scope_forbidden', 403);
        return { clinic, owner: membership.rol_clinica === 'propietario' };
    }
    function receipt(row, currentEntityHash) {
        row = plain(row);
        return {
            id: row.id, scopeType: row.scope_type, scopeId: Number(row.scope_id), slug: row.document_slug,
            version: row.document_version, sha256: row.document_sha256, acceptanceKind: row.acceptance_kind,
            acceptedAt: row.accepted_at, actorUserId: Number(row.actor_user_id), actorName: row.actor_name,
            authorityDeclared: row.authority_declared, authorityDeclarationVersion: row.authority_declaration_version,
            authorityDeclarationText: row.authority_declaration_text, authorityDeclarationSha256: row.authority_declaration_sha256,
            contractingEntity: row.contracting_entity, contractingEntitySha256: row.contracting_entity_sha256,
            appliesToCurrentEntity: row.contracting_entity_sha256 === currentEntityHash,
            documentAvailable: catalog.matchesReceipt(row),
        };
    }
    return {
        async status(req) {
            const actorId = requireActor(req);
            const scope = parseScope(req.query);
            const { clinic, owner } = await scopeAccess(actorId, scope.scopeId);
            if (!owner) throw fail('legal_clinic_owner_required', 403);
            const entity = contractingEntity(clinic), complete = entityComplete(entity), hash = complete ? entityHash(entity) : null;
            const rows = await db.LegalDocumentAcceptance.findAll({ where: { scope_type: 'clinic', scope_id: scope.scopeId }, order: [['accepted_at', 'DESC']], raw: true });
            return { ...scope, canAccept: owner && complete, reason: !owner ? 'legal_clinic_owner_required' : !complete ? 'legal_clinic_identity_incomplete' : null,
                contractingEntity: entity, contractingEntitySha256: hash, authorityDeclaration: DECLARATION,
                documents: catalog.list().documents.filter(doc => doc.current && ['terms', 'dpa'].includes(doc.acceptanceKind)),
                acceptances: rows.map(row => receipt(row, hash)) };
        },
        async accept(req) {
            const actorId = requireActor(req), scope = parseScope(req.body);
            if (req.body.authorityDeclared !== true) throw fail('legal_authority_declaration_required');
            if (req.body.authorityDeclarationVersion !== DECLARATION.version || req.body.authorityDeclarationSha256 !== DECLARATION.sha256) {
                throw fail('legal_authority_declaration_changed', 409);
            }
            if (!digest(req.body.contractingEntitySha256)) throw fail('legal_clinic_identity_evidence_required');
            // This validation runs again under the transaction after any lock wait.
            catalog.requireAcceptance(req.body);
            return db.sequelize.transaction(async transaction => {
                const { clinic, owner } = await scopeAccess(actorId, scope.scopeId, transaction);
                if (!owner) throw fail('legal_clinic_owner_required', 403);
                const entity = contractingEntity(clinic), hash = entityHash(entity);
                if (!entityComplete(entity)) throw fail('legal_clinic_identity_incomplete', 409);
                if (req.body.contractingEntitySha256 !== hash) throw fail('legal_clinic_identity_changed', 409);
                const user = plain(await db.Usuario.findByPk(actorId, { transaction, lock: transaction.LOCK.UPDATE, raw: true }));
                if (!user || user.estado_cuenta && user.estado_cuenta !== 'activo' || user.es_provisional === true) throw fail('legal_actor_inactive', 403);
                const identity = actorFields(user);
                await revalidateAuth(req, transaction);
                const doc = catalog.requireAcceptance(req.body);
                const key = { scope_type: 'clinic', scope_id: scope.scopeId, document_slug: doc.slug, document_version: doc.version,
                    document_sha256: doc.sha256, contracting_entity_sha256: hash };
                const existing = await db.LegalDocumentAcceptance.findOne({ transaction, where: key, raw: true });
                if (existing) return { acceptance: receipt(existing, hash), replayed: true };
                const row = await db.LegalDocumentAcceptance.create({ ...key, id: uuid(), acceptance_kind: doc.acceptanceKind, accepted_at: now(),
                    ...identity, authentication_context: authContext(req), authority_declared: true,
                    authority_declaration_version: DECLARATION.version, authority_declaration_text: DECLARATION.text,
                    authority_declaration_sha256: DECLARATION.sha256, authority_basis: 'clinic_owner_declaration', contracting_entity: entity }, { transaction });
                return { acceptance: receipt(row, hash), replayed: false };
            });
        },
        prepareRegistration(body) {
            const activeTerms = catalog.activeTerms();
            const input = body?.legalEvidence?.terms;
            if (!activeTerms && !input) return null;
            if (!input || input.accepted !== true) throw fail('legal_terms_acceptance_required');
            return catalog.requireAcceptance(input, 'terms');
        },
        async recordRegistration({ user, document, transaction, req }) {
            if (!document) return;
            const doc = catalog.requireAcceptance(document, 'terms');
            const identity = actorFields(user);
            // This is the account holder's terms acceptance, never clinic authority.
            const entity = { userId: Number(user.id_usuario) };
            return db.LegalDocumentAcceptance.create({ id: uuid(), scope_type: 'user', scope_id: entity.userId,
                document_slug: doc.slug, document_version: doc.version, document_sha256: doc.sha256, acceptance_kind: 'terms',
                accepted_at: now(), ...identity, authentication_context: authContext(req, true), authority_declared: false,
                authority_declaration_version: null, authority_declaration_text: null, authority_declaration_sha256: null,
                authority_basis: 'account_holder', contracting_entity: entity,
                contracting_entity_sha256: entityHash(entity) }, { transaction });
        },
    };
}
let service;
function getService() { if (!service) service = createLegalAcceptanceService({ db: require('../../models') }); return service; }
module.exports = { createLegalAcceptanceService, getService, requireActor, contractingEntity, entityHash, DECLARATION };
