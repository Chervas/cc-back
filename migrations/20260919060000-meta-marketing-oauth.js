'use strict';
module.exports={async up(qi){
  await qi.sequelize.query(`CREATE TABLE MetaMarketingOAuthSlots (
    scope_key VARCHAR(64) NOT NULL PRIMARY KEY,connection_ref VARCHAR(128) NOT NULL UNIQUE,asset_ref VARCHAR(128) NOT NULL UNIQUE,
    app_id VARCHAR(30) NOT NULL,clinic_ids TEXT NOT NULL,scopes TEXT NOT NULL,redirect_uri VARCHAR(512) NOT NULL,
    expires_at DATETIME(3) NOT NULL,state ENUM('active','blocked') NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  await qi.sequelize.query(`CREATE TABLE MetaMarketingOAuthRequests (
    flow_id CHAR(36) NOT NULL PRIMARY KEY,state_hash CHAR(64) NOT NULL UNIQUE,
    scope_key VARCHAR(64) NOT NULL,connection_ref VARCHAR(128) NOT NULL,asset_ref VARCHAR(128) NOT NULL,
    app_id VARCHAR(30) NOT NULL,clinic_ids TEXT NOT NULL,scopes TEXT NOT NULL,redirect_uri VARCHAR(512) NOT NULL,
    slot_digest CHAR(64) NOT NULL,scope_digest CHAR(64) NOT NULL,actor_user_id INT NOT NULL,session_ref CHAR(36) NOT NULL,
    session_expires_at DATETIME(3) NOT NULL,return_origin VARCHAR(256) NOT NULL,requested_at DATETIME(3) NOT NULL,expires_at DATETIME(3) NOT NULL,
    state ENUM('begin_pending','awaiting','processing','staged','cancel_pending','cancelled','interrupted') NOT NULL,
    code_digest CHAR(64) NULL UNIQUE,candidate_metadata TEXT NULL,attempts INT UNSIGNED NOT NULL DEFAULT 0,next_attempt_at DATETIME(3) NOT NULL,
    lease_token CHAR(36) NULL,lease_until DATETIME(3) NULL,last_error VARCHAR(48) NULL,completed_at DATETIME(3) NULL,
    INDEX cc_meta_oauth_delivery(state,next_attempt_at,lease_until),INDEX cc_meta_oauth_scope(scope_key,requested_at),INDEX cc_meta_oauth_scope_state(scope_key,state)
  ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
},async down(qi){
  for(const table of ['MetaMarketingOAuthRequests','MetaMarketingOAuthSlots']){
    const [rows]=await qi.sequelize.query('SELECT COUNT(*) n FROM '+table);if(Number(rows[0].n))throw Error('Preserve Meta OAuth authorization history and slots');
  }
  await qi.dropTable('MetaMarketingOAuthRequests');await qi.dropTable('MetaMarketingOAuthSlots');
}};
