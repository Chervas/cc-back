'use strict';
const TABLE='GoogleOAuthAdmissionRecoveries';
module.exports={
 async up(qi){await qi.sequelize.query(`CREATE TABLE \`${TABLE}\` (
 attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 crm_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 dispatch_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 binding_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,actor_user_id INT NOT NULL,
 session_ref_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,session_expires_at DATETIME(3) NOT NULL,
 scope_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,clinic_ids TEXT NOT NULL,
 clinic_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,service ENUM('analytics') NOT NULL,
 clinic_id INT NOT NULL,asset_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 selection_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,attempt_requested_at DATETIME(3) NOT NULL,attempt_expires_at DATETIME(3) NOT NULL,
 google_user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,subject_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 claim_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,scope_lock CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 subject_lock CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 state ENUM('prepared','dispatch_pending','effect_unknown','remote_confirmed','sql_committed','published','quarantine_pending','quarantined','closed_unused') NOT NULL,
 revision INT UNSIGNED NOT NULL,generation INT UNSIGNED NOT NULL,lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,lease_until DATETIME(3) NULL,
 owner_observation TEXT NULL,owner_observation_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 owner_receipt TEXT NULL,owner_receipt_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 native_resource TEXT NULL,native_resource_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 sql_publication_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,last_error VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NULL,
 created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,completed_at DATETIME(3) NULL,
 UNIQUE KEY cc_google_recovery_intent(crm_intent_id),UNIQUE KEY cc_google_recovery_dispatch(dispatch_request_id),
 UNIQUE KEY cc_google_recovery_scope(scope_lock),UNIQUE KEY cc_google_recovery_subject(subject_lock),KEY cc_google_recovery_due(state,lease_until),
 CONSTRAINT cc_google_recovery_ids_positive CHECK(actor_user_id>0 AND clinic_id>0 AND generation>0)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);},
 async down(qi){const [rows]=await qi.sequelize.query(`SELECT attempt_id FROM \`${TABLE}\` LIMIT 1`);if(rows.length)throw Error('google_oauth_admission_recoveries_have_history');await qi.dropTable(TABLE);},
};
