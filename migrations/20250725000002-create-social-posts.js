'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('social_posts', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      asset_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'ClinicMetaAssets',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      asset_type: {
        type: Sequelize.ENUM('facebook_page', 'instagram_business'),
        allowNull: false
      },
      post_id: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: 'ID único del post en la plataforma (Facebook/Instagram)'
      },
      post_type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Tipo de publicación (photo, video, carousel, etc.)'
      },
      title: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Título o primera parte del contenido'
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Contenido completo del post'
      },
      media_url: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'URL de la imagen o video principal'
      },
      permalink_url: {
        type: Sequelize.STRING(512),
        allowNull: true,
        comment: 'URL permanente para ver el post'
      },
      published_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Fecha de publicación'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });

    // Crear índices para optimizar consultas
    await queryInterface.addIndex('social_posts', ['clinica_id', 'asset_id'], {
      name: 'idx_social_posts_clinica_asset'
    });

    await queryInterface.addIndex('social_posts', ['post_id'], {
      name: 'idx_social_posts_post_id'
    });

    await queryInterface.addIndex('social_posts', ['published_at'], {
      name: 'idx_social_posts_published_at'
    });

    // Crear índice único para evitar duplicados
    await queryInterface.addIndex('social_posts', ['asset_id', 'post_id'], {
      name: 'idx_social_posts_asset_post_unique',
      unique: true
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('social_posts');
  }
};

