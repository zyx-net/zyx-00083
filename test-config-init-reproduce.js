const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const moment = require('moment');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'tracking.db');

function logPass(msg) {
  console.log(`✓ PASS: ${msg}`);
}

function logFail(msg, error) {
  console.log(`✗ FAIL: ${msg}`);
  if (error) {
    console.log(`  错误: ${error.message}`);
  }
  process.exitCode = 1;
}

console.log('========================================');
console.log('  配置初始化问题 - 复现测试');
console.log('========================================');
console.log();
console.log('测试场景: 数据库已有 v1.0.0 但无 active 版本');
console.log('预期: 修复前会因唯一约束崩溃；修复后自动恢复 v1.0.0 为 active');
console.log();

async function reproduceIssue() {
  try {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log('已清理旧数据库');
    }

    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = new sqlite3.Database(dbPath);
    console.log('已创建空数据库');

    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS configurations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        temp_min REAL NOT NULL,
        temp_max REAL NOT NULL,
        delivery_time_limit INTEGER NOT NULL,
        acceptance_rules TEXT NOT NULL,
        correction_review_time_limit INTEGER DEFAULT 24,
        correctable_fields_whitelist TEXT DEFAULT '["current_custodian","temperature","timestamp","operator","custodian_type"]',
        allow_reexport INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 0
      )`);

      db.run(`INSERT INTO configurations (
        version, temp_min, temp_max, delivery_time_limit, 
        acceptance_rules, correction_review_time_limit, 
        correctable_fields_whitelist, allow_reexport, created_at, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [
        'v1.0.0',
        0,
        8,
        120,
        JSON.stringify({
          require_temperature_check: true,
          require_timestamp: true,
          max_acceptable_temp_deviation: 2,
          require_custodian_verification: true,
          allow_partial_acceptance: false
        }),
        24,
        JSON.stringify(['current_custodian', 'temperature', 'timestamp', 'operator', 'custodian_type']),
        1,
        moment().format('YYYY-MM-DD HH:mm:ss')
      ], function(err) {
        if (err) {
          logFail('插入测试数据失败', err);
          return;
        }
        console.log('✓ 已插入测试数据: v1.0.0，is_active = 0');
      });

      db.get('SELECT COUNT(*) as cnt FROM configurations', (err, row) => {
        if (err) {
          logFail('查询配置失败', err);
          return;
        }
        console.log(`✓ 数据库当前有 ${row.cnt} 条配置记录`);
      });

      db.get('SELECT version, is_active FROM configurations', (err, row) => {
        if (err) {
          logFail('查询配置详情失败', err);
          return;
        }
        console.log(`✓ 配置详情: version=${row.version}, is_active=${row.is_active}`);
        
        if (row.is_active === 0 && row.version === 'v1.0.0') {
          logPass('场景准备完成: 有 v1.0.0 但无 active 版本');
          console.log();
          console.log('现在请执行以下步骤验证:');
          console.log('1. 运行: node test-config-init-before-fix.js  (验证修复前会崩溃)');
          console.log('2. 运行: node test-config-init-after-fix.js   (验证修复后能正常启动)');
          console.log('3. 或直接运行: npm start 查看启动日志');
        } else {
          logFail('场景准备失败: 配置状态不正确');
        }
      });
    });

    db.close();
  } catch (error) {
    logFail('测试执行异常', error);
  }
}

reproduceIssue();
