const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../../data/tracking.db');

let db;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('数据库连接失败:', err.message);
        reject(err);
      } else {
        console.log('SQLite 数据库连接成功');
        initTables().then(resolve).catch(reject);
      }
    });
  });
}

function initTables() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS configurations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        temp_min REAL NOT NULL,
        temp_max REAL NOT NULL,
        delivery_time_limit INTEGER NOT NULL,
        acceptance_rules TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 0
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS boxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        box_no TEXT NOT NULL UNIQUE,
        batch_no TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CREATED',
        current_custodian TEXT NOT NULL,
        custodian_type TEXT NOT NULL,
        meal_items TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        is_exception INTEGER DEFAULT 0,
        exception_reason TEXT
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS temperature_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        box_no TEXT NOT NULL,
        temperature REAL NOT NULL,
        timestamp TEXT NOT NULL,
        recorded_by TEXT NOT NULL,
        is_abnormal INTEGER DEFAULT 0,
        FOREIGN KEY (box_no) REFERENCES boxes(box_no)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        box_no TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        operator TEXT NOT NULL,
        operator_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        remark TEXT,
        FOREIGN KEY (box_no) REFERENCES boxes(box_no)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        box_no TEXT,
        operator TEXT NOT NULL,
        details TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS exported_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_type TEXT NOT NULL,
        doc_no TEXT NOT NULL UNIQUE,
        box_no TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      )`, (err) => {
        if (err) reject(err);
        else {
          console.log('数据库表初始化完成');
          resolve();
        }
      });
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = { db, run, get, all, initDatabase };
