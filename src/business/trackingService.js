const { get, run, all } = require('../database/init');
const { getActiveConfig, getConfigByVersion } = require('../config/configManager');
const moment = require('moment');

const STATUS_FLOW = {
  CREATED: { next: ['MEAL_PREPARED'], label: '已建档' },
  MEAL_PREPARED: { next: ['BOXED'], label: '已出餐' },
  BOXED: { next: ['DRIVER_RECEIVED'], label: '已装箱' },
  DRIVER_RECEIVED: { next: ['STORE_ACCEPTED', 'EXCEPTION_ISOLATED'], label: '司机已接收' },
  STORE_ACCEPTED: { next: ['ARCHIVED'], label: '门店已验收' },
  EXCEPTION_ISOLATED: { next: ['ARCHIVED'], label: '异常已隔离' },
  ARCHIVED: { next: [], label: '已归档' }
};

const CUSTODIAN_TYPES = {
  KITCHEN: '厨房',
  DRIVER: '司机',
  STORE: '门店',
  QC: '质控',
  ADMIN: '管理员',
  SYSTEM: '系统'
};

class AppError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
    this.name = 'AppError';
  }
}

async function logAudit(action, boxNo, operator, details, success = true, errorMessage = null) {
  await run(
    `INSERT INTO audit_logs (action, box_no, operator, details, timestamp, success, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      action,
      boxNo,
      operator,
      typeof details === 'string' ? details : JSON.stringify(details),
      moment().format('YYYY-MM-DD HH:mm:ss'),
      success ? 1 : 0,
      errorMessage
    ]
  );
}

async function addStatusHistory(boxNo, fromStatus, toStatus, operator, operatorType, remark = null) {
  await run(
    `INSERT INTO status_history (box_no, from_status, to_status, operator, operator_type, timestamp, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      boxNo,
      fromStatus,
      toStatus,
      operator,
      operatorType,
      moment().format('YYYY-MM-DD HH:mm:ss'),
      remark
    ]
  );
}

async function validateTemperature(temp, config) {
  if (typeof temp !== 'number' || isNaN(temp)) {
    throw new AppError('温度必须为有效数字');
  }
  if (temp < config.temp_min || temp > config.temp_max) {
    return { valid: false, reason: `温度 ${temp}°C 超出阈值范围 [${config.temp_min}, ${config.temp_max}]°C` };
  }
  return { valid: true };
}

async function validateCustodian(box, operator) {
  if (box.current_custodian !== operator) {
    throw new AppError(`非当前保管人交接，当前保管人: ${box.current_custodian}，操作人: ${operator}`);
  }
}

async function validateStatusTransition(fromStatus, toStatus, isException = false) {
  if (fromStatus === 'EXCEPTION_ISOLATED' && toStatus === 'STORE_ACCEPTED') {
    throw new AppError('异常隔离后不能进行正常验收，请先归档');
  }
  
  const currentFlow = STATUS_FLOW[fromStatus];
  if (!currentFlow) {
    throw new AppError(`无效的当前状态: ${fromStatus}`);
  }
  
  if (!currentFlow.next.includes(toStatus)) {
    throw new AppError(`不允许的状态流转: ${fromStatus} -> ${toStatus}`);
  }
}

async function createBox(boxData) {
  const existing = await get('SELECT id FROM boxes WHERE box_no = ?', [boxData.box_no]);
  if (existing) {
    throw new AppError(`箱号 ${boxData.box_no} 已存在，不允许重复建档`);
  }

  const config = await getActiveConfig();
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  await run(
    `INSERT INTO boxes (box_no, batch_no, status, current_custodian, custodian_type, meal_items, rule_version, created_at, updated_at)
     VALUES (?, ?, 'CREATED', ?, ?, ?, ?, ?, ?)`,
    [
      boxData.box_no,
      boxData.batch_no,
      boxData.kitchen_staff,
      'KITCHEN',
      JSON.stringify(boxData.meal_items),
      config.version,
      now,
      now
    ]
  );

  await addStatusHistory(boxData.box_no, null, 'CREATED', boxData.kitchen_staff, 'KITCHEN', '餐盒建档');
  await logAudit('CREATE_BOX', boxData.box_no, boxData.kitchen_staff, boxData);

  return getBoxDetail(boxData.box_no);
}

async function updateBoxStatus(boxNo, toStatus, operator, operatorType, data = {}) {
  const box = await get('SELECT * FROM boxes WHERE box_no = ?', [boxNo]);
  if (!box) {
    throw new AppError(`箱号 ${boxNo} 不存在`, 404);
  }

  await validateCustodian(box, operator);
  await validateStatusTransition(box.status, toStatus, data.is_exception);

  const config = await getConfigByVersion(box.rule_version);
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  if (toStatus === 'STORE_ACCEPTED' && config.acceptance_rules.require_timestamp) {
    if (!data.timestamp) {
      throw new AppError('门店验收必须提供时间戳');
    }
  }

  if (data.temperature !== undefined) {
    const tempCheck = await validateTemperature(data.temperature, config);
    if (!tempCheck.valid) {
      throw new AppError(tempCheck.reason);
    }
  }

  const newCustodian = data.new_custodian || operator;
  const newCustodianType = data.new_custodian_type || operatorType;

  await run(
    `UPDATE boxes SET status = ?, current_custodian = ?, custodian_type = ?, updated_at = ? WHERE box_no = ?`,
    [toStatus, newCustodian, newCustodianType, now, boxNo]
  );

  if (toStatus === 'ARCHIVED') {
    await run(`UPDATE boxes SET archived_at = ? WHERE box_no = ?`, [now, boxNo]);
  }

  if (toStatus === 'EXCEPTION_ISOLATED') {
    await run(
      `UPDATE boxes SET is_exception = 1, exception_reason = ? WHERE box_no = ?`,
      [data.exception_reason || '异常隔离', boxNo]
    );
  }

  await addStatusHistory(boxNo, box.status, toStatus, operator, operatorType, data.remark);
  await logAudit(`STATUS_${toStatus}`, boxNo, operator, { from: box.status, to: toStatus, ...data });

  return getBoxDetail(boxNo);
}

async function recordTemperature(boxNo, temperature, timestamp, recordedBy) {
  const box = await get('SELECT * FROM boxes WHERE box_no = ?', [boxNo]);
  if (!box) {
    throw new AppError(`箱号 ${boxNo} 不存在`, 404);
  }

  const config = await getConfigByVersion(box.rule_version);

  if (!timestamp) {
    throw new AppError('温度记录必须提供时间戳');
  }

  if (typeof temperature !== 'number' || isNaN(temperature)) {
    throw new AppError('温度必须为有效数字');
  }

  const tempCheck = await validateTemperature(temperature, config);
  const isAbnormal = !tempCheck.valid;

  const result = await run(
    `INSERT INTO temperature_readings (box_no, temperature, timestamp, recorded_by, is_abnormal)
     VALUES (?, ?, ?, ?, ?)`,
    [boxNo, temperature, timestamp, recordedBy, isAbnormal ? 1 : 0]
  );

  await logAudit('TEMPERATURE_RECORD', boxNo, recordedBy, { temperature, timestamp, isAbnormal });

  return {
    id: result.lastID,
    box_no: boxNo,
    temperature,
    timestamp,
    recorded_by: recordedBy,
    is_abnormal: isAbnormal
  };
}

async function getBoxDetail(boxNo) {
  const box = await get('SELECT * FROM boxes WHERE box_no = ?', [boxNo]);
  if (!box) return null;

  const history = await all(
    'SELECT * FROM status_history WHERE box_no = ? ORDER BY timestamp ASC',
    [boxNo]
  );
  const temps = await all(
    'SELECT * FROM temperature_readings WHERE box_no = ? ORDER BY timestamp ASC',
    [boxNo]
  );

  return {
    ...box,
    meal_items: JSON.parse(box.meal_items),
    status_history: history,
    temperature_readings: temps,
    status_label: STATUS_FLOW[box.status]?.label || box.status
  };
}

async function getBoxList(params = {}) {
  let sql = 'SELECT * FROM boxes WHERE 1=1';
  const paramsList = [];

  if (params.status) {
    sql += ' AND status = ?';
    paramsList.push(params.status);
  }
  if (params.batch_no) {
    sql += ' AND batch_no = ?';
    paramsList.push(params.batch_no);
  }
  if (params.is_exception !== undefined) {
    sql += ' AND is_exception = ?';
    paramsList.push(params.is_exception ? 1 : 0);
  }

  sql += ' ORDER BY created_at DESC';

  const boxes = await all(sql, paramsList);
  return boxes.map(b => ({
    ...b,
    meal_items: JSON.parse(b.meal_items),
    status_label: STATUS_FLOW[b.status]?.label || b.status
  }));
}

async function getAuditLogs(params = {}) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const paramsList = [];

  if (params.box_no) {
    sql += ' AND box_no = ?';
    paramsList.push(params.box_no);
  }
  if (params.action) {
    sql += ' AND action = ?';
    paramsList.push(params.action);
  }

  sql += ' ORDER BY timestamp DESC LIMIT 100';

  return all(sql, paramsList);
}

async function getExceptionList() {
  const boxes = await all(
    `SELECT b.*, 
      (SELECT MAX(timestamp) FROM status_history WHERE box_no = b.box_no AND to_status = 'EXCEPTION_ISOLATED') as isolated_at
     FROM boxes b WHERE b.is_exception = 1 ORDER BY b.updated_at DESC`
  );

  return boxes.map(b => ({
    ...b,
    meal_items: JSON.parse(b.meal_items),
    status_label: STATUS_FLOW[b.status]?.label || b.status
  }));
}

module.exports = {
  STATUS_FLOW,
  CUSTODIAN_TYPES,
  AppError,
  createBox,
  updateBoxStatus,
  recordTemperature,
  getBoxDetail,
  getBoxList,
  getAuditLogs,
  getExceptionList,
  logAudit,
  validateTemperature
};
