'use strict';
const TABLE = 'LegalDocumentAcceptances';
const indexes = [
    { name: 'legal_acceptance_scope_document_entity', unique: true, fields: ['scope_type', 'scope_id', 'document_slug', 'document_version', 'document_sha256', 'contracting_entity_sha256'] },
    { name: 'legal_acceptance_scope_time', fields: ['scope_type', 'scope_id', 'accepted_at'] },
];
function fields(T) {
    return {
        id: { type: T.UUID, primaryKey: true, allowNull: false },
        scope_type: { type: T.STRING(16), allowNull: false },
        scope_id: { type: T.INTEGER, allowNull: false },
        document_slug: { type: T.STRING(64), allowNull: false },
        document_version: { type: T.STRING(64), allowNull: false },
        document_sha256: { type: T.STRING(64), allowNull: false },
        acceptance_kind: { type: T.STRING(16), allowNull: false },
        accepted_at: { type: T.DATE(3), allowNull: false },
        actor_user_id: { type: T.INTEGER, allowNull: false },
        actor_name: { type: T.STRING(255), allowNull: false },
        actor_email: { type: T.STRING(254), allowNull: false },
        authentication_context: { type: T.JSON, allowNull: false },
        authority_declared: { type: T.BOOLEAN, allowNull: false },
        authority_declaration_version: { type: T.STRING(64), allowNull: true },
        authority_declaration_text: { type: T.TEXT, allowNull: true },
        authority_declaration_sha256: { type: T.STRING(64), allowNull: true },
        authority_basis: { type: T.STRING(32), allowNull: false },
        contracting_entity: { type: T.JSON, allowNull: false },
        contracting_entity_sha256: { type: T.STRING(64), allowNull: false },
    };
}
module.exports = { TABLE, fields, indexes };
