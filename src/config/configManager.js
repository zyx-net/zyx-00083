const { get, run, all } = require('../database/init');
const moment = require('moment');

const DEFAULT_CONFIG = {
  version: 'v1.0.0',
  temp_min: 0,
  temp_max: 8,
  delivery_time_limit: 120,
  acceptance_rules: JSON.stringify({
    require_temperature_check: true,
    require_timestamp: true,
    max_acceptable_temp_deviation: 2,
    require_custodian_verification: true,
    allow_partial_acceptance: false
  })
};

async function initConfig() {
  const existing = await get('SELECT * FROM configurations WHERE is_active = 1');
  if (!existing) {
    await run(
      `INSERT INTO configurations (version, temp_min, temp_max, delivery_time_limit, acceptance_rules, created_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        DEFAULT_CONFIG.version,
        DEFAULT_CONFIG.temp_min,
        DEFAULT_CONFIG.temp_max,
        DEFAULT_CONFIG.delivery_time_limit,
        DEFAULT_CONFIG.acceptance_rules,
        moment().format('YYYY-MM-DD HH:mm:ss')
      ]
    );
    console.log('默认配置已加载，版本:', DEFAULT_CONFIG.version);
  } else {
    console.log('当前活动配置版本:', existing.version);
  }
}

async function getActiveConfig() {
  const config = await get('SELECT * FROM configurations WHERE is_active = 1');
  if (!config) {
    await initConfig();
    return getActiveConfig();
  }
  return {
    ...config,
    acceptance_rules: JSON.parse(config.acceptance_rules)
  };
}

async function getConfigByVersion(version) {
  const config = await get('SELECT * FROM configurations WHERE version = ?', [version]);
  if (config) {
    config.acceptance_rules = JSON.parse(config.acceptance_rules);
  }
  return config;
}

async function getAllConfigs() {
  const configs = await all('SELECT * FROM configurations ORDER BY created_at DESC');
  return configs.map(c => ({
    ...c,
    acceptance_rules: JSON.parse(c.acceptance_rules)
  }));
}

async function addNewConfig(newConfig, operator) {
  await run('UPDATE configurations SET is_active = 0 WHERE is_active = 1');
  
  const result = await run(
    `INSERT INTO configurations (version, temp_min, temp_max, delivery_time_limit, acceptance_rules, created_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      newConfig.version,
      newConfig.temp_min,
      newConfig.temp_max,
      newConfig.delivery_time_limit,
      JSON.stringify(newConfig.acceptance_rules),
      moment().format('YYYY-MM-DD HH:mm:ss')
    ]
  );

  await run(
    `INSERT INTO audit_logs (action, operator, details, timestamp)
     VALUES (?, ?, ?, ?)`,
    [
      'CONFIG_UPDATE',
      operator,
      JSON.stringify({ old_version: newConfig.version, newConfig }),
      moment().format('YYYY-MM-DD HH:mm:ss')
    ]
  );

  return result.lastID;
}

module.exports = {
  initConfig,
  getActiveConfig,
  getConfigByVersion,
  getAllConfigs,
  addNewConfig,
  DEFAULT_CONFIG
};
