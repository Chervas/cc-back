'use strict';

// Bounded parameterized SQL only; no ORM, workers, application bootstrap, env
// loading or connection creation. The connection is provided by the operator.
const { hash } = require('./adapter');
const { materializedRow, fullSha, validateStoragePatch } = require('./bs-catalog-migration-apply');
const fail = code => { throw Error(code); };
function createBsCatalogMigrationStore(connection, { readOnly = true } = {}) {
    let inTransaction = false;
    return {
        async verifyScope({ expectedDatabase, inTransaction: lock = false } = {}) {
            const [database] = await connection.query('SELECT DATABASE() AS database_name');
            if (database.length !== 1 || !database[0].database_name || (expectedDatabase && database[0].database_name !== expectedDatabase)) fail('BS_CATALOG_DATABASE_SCOPE_CHANGED');
            const [clinics] = await connection.query(`SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica${lock && !readOnly ? ' LOCK IN SHARE MODE' : ''}`);
            if (hash(clinics.map(r => ({ id: Number(r.id_clinica), group: Number(r.grupoClinicaId) }))) !== hash([{ id: 66, group: 29 }, { id: 72, group: 29 }])) fail('BS_CATALOG_CLINIC_GROUP_DRIFT');
            const [triggers] = await connection.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='Tratamientos' LIMIT 1");
            if (triggers.length) fail('BS_CATALOG_TREATMENT_TRIGGERS_REQUIRE_REVIEW');
            const [tables] = await connection.query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Tratamientos'");
            if (tables.length !== 1 || tables[0].ENGINE !== 'InnoDB') fail('BS_CATALOG_TRANSACTIONAL_STORAGE_REQUIRED');
            const [indexes] = await connection.query("SELECT COLUMN_NAME,NON_UNIQUE,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Tratamientos' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX");
            if (indexes.length !== 1 || indexes[0].COLUMN_NAME !== 'id_tratamiento' || Number(indexes[0].NON_UNIQUE) !== 0
                || Number(indexes[0].SEQ_IN_INDEX) !== 1) fail('BS_CATALOG_PRIMARY_IDENTITY_INDEX_REQUIRED');
            const [columns] = await connection.query("SELECT COLUMN_NAME,DATA_TYPE,NUMERIC_SCALE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Tratamientos' AND COLUMN_NAME IN ('precio_base','clinical_config','updatedAt') ORDER BY COLUMN_NAME");
            const price = columns.find(c => c.COLUMN_NAME === 'precio_base'), config = columns.find(c => c.COLUMN_NAME === 'clinical_config'), timestamp = columns.find(c => c.COLUMN_NAME === 'updatedAt');
            if (columns.length !== 3 || price?.DATA_TYPE !== 'decimal' || Number(price.NUMERIC_SCALE) !== 2
                || !['json', 'text', 'longtext'].includes(config?.DATA_TYPE) || !['datetime', 'timestamp'].includes(timestamp?.DATA_TYPE)) fail('BS_CATALOG_STORAGE_CONTRACT_CHANGED');
            return { database: database[0].database_name, clinic_ids: [66, 72], group_id: 29 };
        },
        async begin({ readOnly: requested = true } = {}) {
            if (inTransaction || (!requested && readOnly)) fail('BS_CATALOG_TRANSACTION_MODE_INVALID');
            await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await connection.query(requested ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY' : 'START TRANSACTION');
            inTransaction = true;
        },
        async readTreatment(id, clinicId, { lock = false } = {}) {
            if (!inTransaction || !Number.isSafeInteger(id) || id < 1 || ![66, 72].includes(clinicId) || (lock && readOnly)) fail('BS_CATALOG_ROW_READ_SCOPE_INVALID');
            const [rows] = await connection.query(`SELECT * FROM Tratamientos WHERE id_tratamiento=? AND clinica_id=?${lock ? ' FOR UPDATE' : ''}`, [id, clinicId]);
            if (rows.length > 1) fail('BS_CATALOG_ROW_IDENTITY_NOT_UNIQUE');
            return rows[0] ? materializedRow(rows[0]) : null;
        },
        async writeTreatment({ op, current, target, direction }) {
            if (readOnly || !inTransaction) fail('BS_CATALOG_READ_ONLY_STORE');
            // A second locked read makes the adapter safe even when used by a
            // caller other than the executor. Never trust a request row for CAS.
            const live = await this.readTreatment(op.treatment_id, op.clinic_id, { lock: true });
            if (!live || fullSha(live) !== fullSha(current)) fail('BS_CATALOG_LOCKED_ROW_CAS_FAILED');
            // SELECT holds the table metadata lock through this transaction;
            // recheck trigger/storage metadata after acquiring that lock.
            await this.verifyScope({ inTransaction: true });
            validateStoragePatch({ op, current: live, target, direction });
            const changedPrice = op.changes.some(c => c.path === 'precio_base');
            const changedConfig = op.changes.some(c => c.path.startsWith('clinical_config.'));
            if (!changedPrice && !changedConfig) fail('BS_CATALOG_EMPTY_SQL_PATCH');
            const assignments = [], values = [];
            if (changedPrice) { assignments.push('precio_base=?'); values.push(target.precio_base); }
            if (changedConfig) { assignments.push('clinical_config=?'); values.push(JSON.stringify(target.clinical_config)); }
            assignments.push('updatedAt=UTC_TIMESTAMP()');
            const [result] = await connection.query(`UPDATE Tratamientos SET ${assignments.join(',')} WHERE id_tratamiento=? AND clinica_id=? AND updatedAt <=> ?`,
                [...values, op.treatment_id, op.clinic_id, current.updatedAt]);
            if (result.affectedRows !== 1) fail('BS_CATALOG_SQL_CAS_UPDATE_COUNT_INVALID');
        },
        async commit() { if (!inTransaction || readOnly) fail('BS_CATALOG_COMMIT_MODE_INVALID'); await connection.commit(); inTransaction = false; },
        async rollback() { if (inTransaction) { await connection.rollback(); inTransaction = false; } },
    };
}
module.exports = { createBsCatalogMigrationStore };
