'use strict';

module.exports = (sequelize, D) => sequelize.define('GoogleOAuthAdmissionPublication', {
  attempt_id:{ type:D.CHAR(36),primaryKey:true,allowNull:false },
  receipt_id:{ type:D.CHAR(36),allowNull:false,unique:'cc_google_publication_receipt' },
  receipt_digest:{ type:D.CHAR(64),allowNull:false },
  google_connection_id:{ type:D.INTEGER,allowNull:false },
  scope_key:{ type:D.STRING(64),allowNull:false },
  service:{ type:D.ENUM('business_profile','search_console','analytics','ads'),allowNull:false },
  clinic_id:{ type:D.INTEGER,allowNull:false },
  asset_ref:{ type:D.STRING(128),allowNull:false },
  published_at:{ type:D.DATE(3),allowNull:false },
},{ tableName:'GoogleOAuthAdmissionPublications',timestamps:false,charset:'ascii',collate:'ascii_bin' });
