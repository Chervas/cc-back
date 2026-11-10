'use strict';
// Immutable, selected DDL; application startup never imports or executes it.
const SCHEMA = [
`CREATE TABLE WhatsappContactIdentityLocks (clinic_id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE WhatsappConversationLinks (
 conversation_id INT NOT NULL PRIMARY KEY, canonical_id INT NOT NULL, clinic_id INT NOT NULL,
 source VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, actor_user_id INT NULL,
 created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 INDEX cc_wa_link_canonical(canonical_id,clinic_id), INDEX cc_wa_link_clinic(clinic_id,conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE WhatsappContactIdentities (
 identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 clinic_id INT NOT NULL, business_id VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 identity_type ENUM('phone','bsuid') NOT NULL, identity_value VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 conversation_id INT NOT NULL, waba_id VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NULL,
 phone_id VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin NULL,
 display_name VARCHAR(160) NULL, username VARCHAR(160) NULL, restrictions JSON NULL,
 source VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 INDEX cc_wa_identity_conversation(conversation_id,clinic_id), INDEX cc_wa_identity_search(clinic_id,identity_type,identity_value),
 INDEX cc_wa_identity_username(clinic_id,username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
];
module.exports={SCHEMA,async up(q){for(const sql of SCHEMA)await q.sequelize.query(sql);},
 async down(){throw Error('whatsapp_identity_rollback_requires_preserved_history_plan');}};
