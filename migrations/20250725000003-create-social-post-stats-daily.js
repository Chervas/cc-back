'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('social_post_stats_daily', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      post_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'social_posts',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      impressions: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de veces que se mostró el post'
      },
      reach: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de usuarios únicos que vieron el post'
      },
      engagement: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número total de interacciones'
      },
      likes: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de me gusta'
      },
      comments: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de comentarios'
      },
      shares: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de veces compartido'
      },
      saved: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de veces guardado (principalmente Instagram)'
      },
      video_views: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de reproducciones de video (si aplica)'
      },
      avg_watch_time: {
        type: Sequelize.FLOAT,
        defaultValue: 0,
        comment: 'Tiempo promedio de visualización en segundos (si aplica)'
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
    await queryInterface.addIndex('social_post_stats_daily', ['post_id', 'date'], {
      name: 'idx_social_post_stats_post_date'
    });

    await queryInterface.addIndex('social_post_stats_daily', ['date'], {
      name: 'idx_social_post_stats_date'
    });

    // Crear índice único para evitar duplicados
    await queryInterface.addIndex('social_post_stats_daily', ['post_id', 'date'], {
      name: 'idx_social_post_stats_post_date_unique',
      unique: true
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('social_post_stats_daily');
  }
};

