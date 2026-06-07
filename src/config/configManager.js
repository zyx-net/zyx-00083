const { get, run, all } = require('../database/init');
const moment = require('moment');

const DEFAULT_REPORT_VISIBLE_FIELDS = [
  'batch_no', 'total_boxes', 'status_summary', 'handover_timestamps',
  'temperature_abnormalities', 'isolation_reasons', 'corrections_summary',
  'exported_documents', 'conflict_warnings', 'config_version',
  'generated_at', 'generated_by', 'has_conflicts', 'conflict_details'
];

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
  }),
  correction_review_time_limit: 24,
  correctable_fields_whitelist: JSON.stringify(['current_custodian', 'temperature', 'timestamp', 'operator', 'custodian_type']),
  allow_reexport: 1,
  report_enabled: 1,
  report_visible_fields: JSON.stringify(DEFAULT_REPORT_VISIBLE_FIELDS)
};

async function initConfig() {
  let activeConfig = await get('SELECT * FROM configurations WHERE is_active = 1');
  if (activeConfig) {
    console.log('当前活动配置版本:', activeConfig.version);
    return;
  }

  const v1Config = await get('SELECT * FROM configurations WHERE version = ?', [DEFAULT_CONFIG.version]);
  if (v1Config) {
    await run('UPDATE configurations SET is_active = 1 WHERE version = ?', [DEFAULT_CONFIG.version]);
    console.log('已恢复默认配置为活动状态，版本:', DEFAULT_CONFIG.version);
    return;
  }

  const anyConfig = await get('SELECT * FROM configurations ORDER BY created_at DESC LIMIT 1');
  if (anyConfig) {
    await run('UPDATE configurations SET is_active = 1 WHERE id = ?', [anyConfig.id]);
    console.log('已恢复最新配置为活动状态，版本:', anyConfig.version);
    return;
  }

  await run(
    `INSERT INTO configurations (version, temp_min, temp_max, delivery_time_limit, acceptance_rules, correction_review_time_limit, correctable_fields_whitelist, allow_reexport, report_enabled, report_visible_fields, created_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      DEFAULT_CONFIG.version,
      DEFAULT_CONFIG.temp_min,
      DEFAULT_CONFIG.temp_max,
      DEFAULT_CONFIG.delivery_time_limit,
      DEFAULT_CONFIG.acceptance_rules,
      DEFAULT_CONFIG.correction_review_time_limit,
      DEFAULT_CONFIG.correctable_fields_whitelist,
      DEFAULT_CONFIG.allow_reexport,
      DEFAULT_CONFIG.report_enabled,
      DEFAULT_CONFIG.report_visible_fields,
      moment().format('YYYY-MM-DD HH:mm:ss')
    ]
  );
  console.log('默认配置已加载，版本:', DEFAULT_CONFIG.version);
}

async function getActiveConfig() {
  const config = await get('SELECT * FROM configurations WHERE is_active = 1');
  if (!config) {
    await initConfig();
    return getActiveConfig();
  }
  return {
    ...config,
    acceptance_rules: JSON.parse(config.acceptance_rules),
    correctable_fields_whitelist: config.correctable_fields_whitelist ? JSON.parse(config.correctable_fields_whitelist) : [],
    allow_reexport: config.allow_reexport !== undefined ? config.allow_reexport === 1 : true,
    report_enabled: config.report_enabled !== undefined ? config.report_enabled === 1 : true,
    report_visible_fields: config.report_visible_fields ? JSON.parse(config.report_visible_fields) : DEFAULT_REPORT_VISIBLE_FIELDS
  };
}

async function getConfigByVersion(version) {
  const config = await get('SELECT * FROM configurations WHERE version = ?', [version]);
  if (config) {
    config.acceptance_rules = JSON.parse(config.acceptance_rules);
    config.correctable_fields_whitelist = config.correctable_fields_whitelist ? JSON.parse(config.correctable_fields_whitelist) : [];
    config.allow_reexport = config.allow_reexport !== undefined ? config.allow_reexport === 1 : true;
    config.report_enabled = config.report_enabled !== undefined ? config.report_enabled === 1 : true;
    config.report_visible_fields = config.report_visible_fields ? JSON.parse(config.report_visible_fields) : DEFAULT_REPORT_VISIBLE_FIELDS;
  }
  return config;
}

async function getAllConfigs() {
  const configs = await all('SELECT * FROM configurations ORDER BY created_at DESC');
  return configs.map(c => ({
    ...c,
    acceptance_rules: JSON.parse(c.acceptance_rules),
    correctable_fields_whitelist: c.correctable_fields_whitelist ? JSON.parse(c.correctable_fields_whitelist) : [],
    allow_reexport: c.allow_reexport !== undefined ? c.allow_reexport === 1 : true,
    report_enabled: c.report_enabled !== undefined ? c.report_enabled === 1 : true,
    report_visible_fields: c.report_visible_fields ? JSON.parse(c.report_visible_fields) : DEFAULT_REPORT_VISIBLE_FIELDS
  }));
}

async function addNewConfig(newConfig, operator) {
  await run('UPDATE configurations SET is_active = 0 WHERE is_active = 1');
  
  const result = await run(
    `INSERT INTO configurations (version, temp_min, temp_max, delivery_time_limit, acceptance_rules, correction_review_time_limit, correctable_fields_whitelist, allow_reexport, report_enabled, report_visible_fields, created_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      newConfig.version,
      newConfig.temp_min,
      newConfig.temp_max,
      newConfig.delivery_time_limit,
      JSON.stringify(newConfig.acceptance_rules),
      newConfig.correction_review_time_limit || 24,
      JSON.stringify(newConfig.correctable_fields_whitelist || ['current_custodian', 'temperature', 'timestamp', 'operator', 'custodian_type']),
      newConfig.allow_reexport !== undefined ? (newConfig.allow_reexport ? 1 : 0) : 1,
      newConfig.report_enabled !== undefined ? (newConfig.report_enabled ? 1 : 0) : 1,
      JSON.stringify(newConfig.report_visible_fields || DEFAULT_REPORT_VISIBLE_FIELDS),
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
  DEFAULT_CONFIG,
  DEFAULT_REPORT_VISIBLE_FIELDS
};
