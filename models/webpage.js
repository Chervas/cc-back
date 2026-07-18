'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebPage = sequelize.define('WebPage', {
    id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      primaryKey: true,
      validate: { isUUID: 4 },
    },
    projectId: { type: DataTypes.STRING(36), allowNull: false, field: 'project_id' },
    pageKey: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'page_key',
      validate: { is: /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/ },
    },
    title: { type: DataTypes.STRING(191), allowNull: false, validate: { len: [1, 191] } },
    slug: {
      type: DataTypes.STRING(160),
      allowNull: false,
      validate: { is: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
    },
    parentPageId: { type: DataTypes.STRING(36), allowNull: true, field: 'parent_page_id' },
    templateId: { type: DataTypes.STRING(36), allowNull: true, field: 'template_id' },
    position: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, validate: { min: 0 } },
    seo: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    status: {
      type: DataTypes.ENUM('draft', 'active', 'archived'),
      allowNull: false,
      defaultValue: 'draft',
    },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
  }, {
    tableName: 'WebPages',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    deletedAt: 'deleted_at',
    paranoid: true,
    indexes: [
      { unique: true, fields: ['project_id', 'page_key'] },
      { unique: true, fields: ['project_id', 'slug'] },
      { fields: ['project_id', 'position', 'deleted_at'] },
      { fields: ['parent_page_id'] },
      { fields: ['template_id'] },
    ],
  });

  WebPage.associate = function associate(models) {
    WebPage.belongsTo(models.WebProject, {
      foreignKey: 'projectId',
      as: 'project',
      onDelete: 'CASCADE',
    });
    WebPage.belongsTo(models.WebPage, {
      foreignKey: 'parentPageId',
      as: 'parentPage',
      onDelete: 'SET NULL',
    });
    WebPage.hasMany(models.WebPage, { foreignKey: 'parentPageId', as: 'childPages' });
    WebPage.belongsTo(models.WebTemplate, {
      foreignKey: 'templateId',
      as: 'template',
      onDelete: 'SET NULL',
    });
    WebPage.belongsTo(models.Usuario, {
      foreignKey: 'createdByUserId',
      targetKey: 'id_usuario',
      as: 'createdBy',
    });
    WebPage.belongsTo(models.Usuario, {
      foreignKey: 'updatedByUserId',
      targetKey: 'id_usuario',
      as: 'updatedBy',
    });
  };

  return WebPage;
};
