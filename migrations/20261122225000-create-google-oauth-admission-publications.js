'use strict';

const TABLE = 'GoogleOAuthAdmissionPublications';

module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE \`${TABLE}\` (
      attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      receipt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      receipt_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      google_connection_id INT NOT NULL,
      scope_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      service ENUM('business_profile','search_console','analytics','ads') NOT NULL,
      clinic_id INT NOT NULL,
      asset_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      published_at DATETIME(3) NOT NULL,
      PRIMARY KEY (attempt_id), UNIQUE KEY cc_google_publication_receipt (receipt_id),
      CONSTRAINT cc_google_publication_ids_positive CHECK (google_connection_id > 0 AND clinic_id > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query(`SELECT attempt_id FROM \`${TABLE}\` LIMIT 1`);
    if (rows.length) throw Error('google_oauth_admission_publications_have_history');
    await qi.dropTable(TABLE);
  },
};
