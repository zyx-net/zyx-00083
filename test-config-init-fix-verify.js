const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const moment = require('moment');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'tracking.db');
const dataDir = path.join(__dirname, 'data');

function logPass(msg) {
  console.log(`✓ PASS: ${msg}`);
}

function logFail(msg, error) {
  console.log(`✗ FAIL: ${msg}`);
  if (error) {
    console.log(`  错误: ${error.message}`);
    if (error.stack) console.log(`  ${error.stack.split('\n')[1]}`);
  }
  process.exitCode = 1;
}

console.log('========================================');
console.log('  配置初始化修复 - 单元测试');
console.log('========================================');
console.log();

let dbInstance = null;

async function initTestDb() {
  if (dbInstance) {
    await new Promise(resolve => dbInstance.close(resolve));
  }
  
  if (fs.existsSync(dbPath)) {
    let retries = 10;
    while (retries-- > 0) {
      try {
        fs.unlinkSync(dbPath);
        break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const { initDatabase } = require('./src/database/init');
  await initDatabase();
  dbInstance = require('./src/database/init').db;
}

async function resetConfigs() {
  const { run } = require('./src/database/init');
  await run('DELETE FROM configurations');
}

async function insertConfig(version, isActive = 0, allowReexport = 1, createdAt = null) {
  const { run } = require('./src/database/init');
  await run(`INSERT INTO configurations (
    version, temp_min, temp_max, delivery_time_limit, 
    acceptance_rules, correction_review_time_limit, 
    correctable_fields_whitelist, allow_reexport, created_at, is_active
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    version, 0, 8, 120,
    JSON.stringify({ require_temperature_check: true }),
    24, JSON.stringify(['current_custodian']),
    allowReexport,
    createdAt || moment().format('YYYY-MM-DD HH:mm:ss'),
    isActive
  ]);
}

async function verifyActiveConfig(expectedVersion, expectedAllowReexport) {
  const { get } = require('./src/database/init');
  const config = await get('SELECT * FROM configurations WHERE is_active = 1');
  
  if (!config) {
    throw new Error('没有找到 active 配置');
  }
  if (config.version !== expectedVersion) {
    throw new Error(`期望 active 版本为 ${expectedVersion}，实际为 ${config.version}`);
  }
  if (expectedAllowReexport !== undefined && config.allow_reexport !== expectedAllowReexport) {
    throw new Error(`期望 allow_reexport 为 ${expectedAllowReexport}，实际为 ${config.allow_reexport}`);
  }
  return config;
}

async function verifyNoActiveConfig() {
  const { get } = require('./src/database/init');
  const config = await get('SELECT * FROM configurations WHERE is_active = 1');
  if (config) {
    throw new Error(`不应该有 active 配置，但实际有 ${config.version}`);
  }
}

async function runTests() {
  const { initConfig, getActiveConfig } = require('./src/config/configManager');
  const { run: dbRun } = require('./src/database/init');

  try {
    await initTestDb();

    console.log('--- 场景1: 有 v1.0.0 但无 active，验证自动恢复 ---');
    await resetConfigs();
    await insertConfig('v1.0.0', 0, 1);
    await verifyNoActiveConfig();
    await initConfig();
    await verifyActiveConfig('v1.0.0', 1);
    logPass('v1.0.0 已自动恢复为 active 状态');

    console.log('\n--- 场景2: 无 v1.0.0 但有其他版本，验证恢复最新 ---');
    await resetConfigs();
    await insertConfig('v1.1.0-custom', 0, 0, moment().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss'));
    await insertConfig('v2.0.0-beta', 0, 1, moment().format('YYYY-MM-DD HH:mm:ss'));
    await verifyNoActiveConfig();
    await initConfig();
    await verifyActiveConfig('v2.0.0-beta', 1);
    logPass('最新版本 v2.0.0-beta 已自动恢复为 active 状态');

    console.log('\n--- 场景3: 有 v1.0.0 和其他版本，优先恢复 v1.0.0 ---');
    await resetConfigs();
    await insertConfig('v1.0.0', 0, 1, moment().subtract(2, 'hour').format('YYYY-MM-DD HH:mm:ss'));
    await insertConfig('v1.1.0-custom', 0, 0, moment().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss'));
    await insertConfig('v2.0.0-beta', 0, 0, moment().format('YYYY-MM-DD HH:mm:ss'));
    await verifyNoActiveConfig();
    await initConfig();
    await verifyActiveConfig('v1.0.0', 1);
    logPass('优先恢复 v1.0.0 为 active 状态（即使有其他版本）');

    console.log('\n--- 场景4: 完全无配置记录，验证插入默认 ---');
    await resetConfigs();
    await initConfig();
    await verifyActiveConfig('v1.0.0', 1);
    logPass('无配置时正确插入默认 v1.0.0');

    console.log('\n--- 场景5: 已有 active 配置，验证不修改 ---');
    await resetConfigs();
    await insertConfig('v1.0.0', 1, 1);
    const config1 = await getActiveConfig();
    await initConfig();
    const config2 = await getActiveConfig();
    if (config1.id !== config2.id) {
      throw new Error('已有 active 配置时不应该修改');
    }
    logPass('已有 active 配置时保持不变');

    console.log('\n--- 场景6: 验证 getActiveConfig 递归恢复能力 ---');
    await resetConfigs();
    await insertConfig('v1.0.0', 0, 1);
    await verifyNoActiveConfig();
    const config3 = await getActiveConfig();
    if (!config3) {
      throw new Error('getActiveConfig 应该能自动恢复配置');
    }
    logPass('getActiveConfig 在无 active 时能自动恢复');

    console.log('\n--- 场景7: 有 v1.0.0 非 active，验证保留 allow_reexport 原值 ---');
    await resetConfigs();
    await insertConfig('v1.0.0', 0, 0);
    await initConfig();
    await verifyActiveConfig('v1.0.0', 0);
    logPass('恢复 v1.0.0 时保留原有 allow_reexport=0 配置');

    console.log('\n========================================');
    if (process.exitCode !== 1) {
      console.log('  ✓ 所有单元测试通过！');
    } else {
      console.log('  ✗ 部分测试失败');
    }
    console.log('========================================\n');

  } catch (error) {
    logFail('测试执行异常', error);
  } finally {
    if (dbInstance) {
      dbInstance.close();
    }
  }
}

runTests();
