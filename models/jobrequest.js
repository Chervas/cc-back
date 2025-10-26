module.exports = (sequelize, DataTypes) => {
  const JobRequest = sequelize.define('JobRequest', {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true
    },
    type: {
      type: DataTypes.STRING(80),
      allowNull: false
    },
    priority: {
      type: DataTypes.ENUM('critical', 'high', 'normal', 'low'),
      allowNull: false,
      defaultValue: 'normal'
    },
    status: {
      type: DataTypes.ENUM('pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending'
    },
    origin: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: 'manual'
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {}
    },
    requested_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    requested_by_name: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    requested_by_role: {
      type: DataTypes.STRING(80),
      allowNull: true
    },
    attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    max_attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 5
    },
    last_attempt_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    next_run_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    sync_log_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    result_summary: {
      type: DataTypes.JSON,
      allowNull: true
    }
  }, {
    tableName: 'JobRequests',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        fields: ['status', 'priority']
      },
      {
        fields: ['priority', 'created_at']
      },
      {
        fields: ['next_run_at']
      }
    ]
  });

  JobRequest.PRIORITIES = ['critical', 'high', 'normal', 'low'];
  JobRequest.STATUSES = ['pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'];

  return JobRequest;
};
