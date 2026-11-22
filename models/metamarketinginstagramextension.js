'use strict';

function fields(D) {
  return {
    flow_id: { type: D.CHAR(36), primaryKey: true, allowNull: false },
    scope_key: { type: D.STRING(24), allowNull: false },
    reserved_scope: { type: D.STRING(24), allowNull: true, unique: true },
    enrollment_id: { type: D.CHAR(36), allowNull: false },
    authority_hash: { type: D.CHAR(64), allowNull: false },
    structure_hash: { type: D.CHAR(64), allowNull: false },
    connection_ref: { type: D.STRING(128), allowNull: false },
    state_hash: { type: D.CHAR(64), allowNull: false, unique: true },
    code_hash: { type: D.CHAR(64), allowNull: true, unique: true },
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
    status: { type: D.ENUM('starting','awaiting','processing','active','cancel_pending','cancelled'), allowNull: false },
  };
}

module.exports = (sequelize, D) => sequelize.define('MetaMarketingInstagramExtension', fields(D), {
  tableName: 'MetaMarketingInstagramExtensions', timestamps: false, charset: 'ascii', collate: 'ascii_bin',
});
module.exports.fields = fields;
