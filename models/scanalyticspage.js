'use strict';
module.exports = (sequelize, DataTypes) => require('../src/lib/searchConsoleAnalyticsSchema').defineModel(sequelize, DataTypes, 'ScAnalyticsPages');
