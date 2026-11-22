'use strict';

const tableName = 'MetaMarketingInstagramExtensions';
const states = ['starting','awaiting','processing','active','cancel_pending','cancelled'];
const uniqueKeys = {
  cc_meta_instagram_scope: { fields: ['reserved_scope'], customIndex: true },
  cc_meta_instagram_state: { fields: ['state_hash'], customIndex: true },
  cc_meta_instagram_code: { fields: ['code_hash'], customIndex: true },
};

function fields(D) {
  return {
    flow_id: { type: D.CHAR(36), primaryKey: true, allowNull: false },
    scope_key: { type: D.STRING(24), allowNull: false },
    reserved_scope: { type: D.STRING(24), allowNull: true },
    enrollment_id: { type: D.CHAR(36), allowNull: false },
    authority_hash: { type: D.CHAR(64), allowNull: false },
    structure_hash: { type: D.CHAR(64), allowNull: false },
    connection_ref: { type: D.STRING(128), allowNull: false },
    state_hash: { type: D.CHAR(64), allowNull: false },
    code_hash: { type: D.CHAR(64), allowNull: true },
    actor_user_id: { type: D.INTEGER, allowNull: false },
    session_ref: { type: D.CHAR(36), allowNull: false },
    session_expires_at: { type: D.DATE(3), allowNull: false },
    requested_at: { type: D.DATE(3), allowNull: false },
    expires_at: { type: D.DATE(3), allowNull: false },
    selected_instagram_id: { type: D.STRING(30), allowNull: true },
    selected_candidate_digest: { type: D.CHAR(64), allowNull: true },
    confirmed_at: { type: D.DATE(3), allowNull: true },
    cancelled_by: { type: D.INTEGER, allowNull: true },
    cancelled_at: { type: D.DATE(3), allowNull: true },
    status: { type: D.ENUM(...states), allowNull: false },
  };
}

module.exports = { tableName, states, uniqueKeys, fields };
