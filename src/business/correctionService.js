const { get, run, all } = require('../database/init');
const { getBoxDetail, getExceptionList, STATUS_FLOW, logAudit, AppError, validateTemperature } = require('./trackingService');
const { getConfigByVersion, getActiveConfig } = require('../config/configManager');
const moment = require('moment');

const CORRECTION_STATUS = {
  PENDING: { label: '待审核', can_review: true },
  APPROVED: { label: '已通过', can_review: false },
  REJECTED: { label: '已驳回', can_review: false },
  EXPIRED: { label: '已过期', can_review: false }
};

const RECORD_TYPES = {
  STATUS_HISTORY: 'status_history',
  TEMPERATURE: 'temperature',
  BOX: 'box'
};

const ROLE_PERMISSIONS = {
  QC: { can_review: true, can_submit: true, reviewable_types: ['status_history', 'temperature', 'box'] },
  KITCHEN: { can_review: false, can_submit: false, reviewable_types: [] },
  DRIVER: { can_review: false, can_submit: true, reviewable_types: [] },
  STORE: { can_review: false, can_submit: true, reviewable_types: [] }
};

function generateCorrectionNo() {
  const dateStr = moment().format('YYYYMMDD');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `GZ${dateStr}${random}`;
}

async function checkBatchArchived(batchNo) {
  const archivedBoxes = await all(
    'SELECT box_no FROM boxes WHERE batch_no = ? AND status = ?',
    [batchNo, 'ARCHIVED']
  );
  const allBoxes = await all(
    'SELECT box_no FROM boxes WHERE batch_no = ?',
    [batchNo]
  );
  if (allBoxes.length === 0) {
    throw new AppError(`批次 ${batchNo} 不存在`, 404);
  }
  if (archivedBoxes.length > 0) {
    throw new AppError(`批次 ${batchNo} 已归档，不允许更正`);
  }
  return false;
}

async function checkPendingConflicts(batchNo, excludeId = null) {
  let sql = 'SELECT * FROM correction_applications WHERE batch_no = ? AND status = ?';
  let params = [batchNo, 'PENDING'];
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  const pending = await all(sql, params);
  const activePending = [];
  const now = moment();
  for (const p of pending) {
    if (moment(p.expires_at).isAfter(now)) {
      activePending.push(p);
    } else {
      await checkAndMarkExpired(p);
    }
  }
  const conflictThreshold = excludeId ? 0 : 1;
  return {
    has_conflict: activePending.length > conflictThreshold,
    count: activePending.length,
    pending_corrections: activePending
  };
}

async function checkAndMarkExpired(correction) {
  if (correction.status !== 'PENDING') return false;
  if (moment().isBefore(moment(correction.expires_at))) return false;

  const existingLog = await get(
    'SELECT id FROM audit_logs WHERE action = ? AND details LIKE ?',
    ['CORRECTION_EXPIRED', `%"correction_id":${correction.id}%`]
  );
  if (existingLog) {
    await run('UPDATE correction_applications SET status = ? WHERE id = ?', ['EXPIRED', correction.id]);
    return true;
  }

  await run('UPDATE correction_applications SET status = ? WHERE id = ?', ['EXPIRED', correction.id]);

  await logAudit('CORRECTION_EXPIRED', correction.box_no, 'SYSTEM', {
    correction_id: correction.id,
    correction_no: correction.correction_no,
    batch_no: correction.batch_no,
    field_name: correction.field_name,
    submitted_at: correction.submitted_at,
    expires_at: correction.expires_at,
    expired_at: moment().format('YYYY-MM-DD HH:mm:ss')
  });

  const conflictCheck = await checkPendingConflicts(correction.batch_no);
  const newWarning = conflictCheck.has_conflict ? 1 : 0;
  await run(
    'UPDATE correction_applications SET conflict_warning = ? WHERE batch_no = ? AND status = ?',
    [newWarning, correction.batch_no, 'PENDING']
  );

  return true;
}

async function ensureCorrectionNotExpired(correction) {
  if (correction.status === 'PENDING') {
    await checkAndMarkExpired(correction);
    if (correction.status === 'PENDING') {
      const updated = await get('SELECT * FROM correction_applications WHERE id = ?', [correction.id]);
      if (updated) Object.assign(correction, updated);
    }
  }
  return correction;
}

async function getOriginalValue(recordType, recordId, fieldName, boxNo) {
  let originalValue = null;
  let record = null;

  switch (recordType) {
    case RECORD_TYPES.STATUS_HISTORY:
      record = await get('SELECT * FROM status_history WHERE id = ?', [recordId]);
      if (!record) throw new AppError(`状态记录 ${recordId} 不存在`, 404);
      if (fieldName === 'operator') originalValue = record.operator;
      else if (fieldName === 'timestamp') originalValue = record.timestamp;
      else if (fieldName === 'custodian_type') originalValue = record.operator_type;
      else throw new AppError(`状态记录不支持更正字段: ${fieldName}`);
      break;

    case RECORD_TYPES.TEMPERATURE:
      record = await get('SELECT * FROM temperature_readings WHERE id = ?', [recordId]);
      if (!record) throw new AppError(`温度记录 ${recordId} 不存在`, 404);
      if (fieldName === 'temperature') originalValue = record.temperature;
      else if (fieldName === 'timestamp') originalValue = record.timestamp;
      else if (fieldName === 'operator' || fieldName === 'custodian_type') originalValue = record.recorded_by;
      else throw new AppError(`温度记录不支持更正字段: ${fieldName}`);
      break;

    case RECORD_TYPES.BOX:
      record = await get('SELECT * FROM boxes WHERE box_no = ?', [boxNo]);
      if (!record) throw new AppError(`餐盒 ${boxNo} 不存在`, 404);
      if (fieldName === 'current_custodian') originalValue = record.current_custodian;
      else if (fieldName === 'custodian_type') originalValue = record.custodian_type;
      else throw new AppError(`餐盒记录不支持更正字段: ${fieldName}`);
      break;

    default:
      throw new AppError(`无效的记录类型: ${recordType}`);
  }

  if (originalValue === null || originalValue === undefined) {
    throw new AppError(`无法获取字段 ${fieldName} 的原始值`);
  }

  return {
    original_value: typeof originalValue === 'number' ? originalValue.toString() : originalValue,
    record
  };
}

async function validateProposedValue(fieldName, proposedValue, recordType, config) {
  switch (fieldName) {
    case 'temperature':
      const temp = parseFloat(proposedValue);
      const tempCheck = await validateTemperature(temp, config);
      if (!tempCheck.valid) {
        throw new AppError(tempCheck.reason);
      }
      break;
    case 'timestamp':
      if (!moment(proposedValue, 'YYYY-MM-DD HH:mm:ss', true).isValid()) {
        throw new AppError('时间戳格式无效，应为 YYYY-MM-DD HH:mm:ss');
      }
      break;
    case 'operator':
    case 'current_custodian':
      if (typeof proposedValue !== 'string' || proposedValue.trim().length === 0) {
        throw new AppError(`${fieldName} 不能为空`);
      }
      break;
    case 'custodian_type':
      const validTypes = ['KITCHEN', 'DRIVER', 'STORE', 'QC', 'SYSTEM'];
      if (!validTypes.includes(proposedValue)) {
        throw new AppError(`保管人类型必须是 ${validTypes.join(', ')} 之一`);
      }
      break;
  }
}

async function submitCorrection(correctionData) {
  const {
    box_no,
    record_type,
    record_id,
    field_name,
    proposed_value,
    apply_reason,
    applicant,
    applicant_type
  } = correctionData;

  if (!ROLE_PERMISSIONS[applicant_type]?.can_submit) {
    throw new AppError(`角色 ${applicant_type} 没有提交更正申请的权限，可提交角色：DRIVER/STORE/QC`, 403);
  }

  const box = await get('SELECT * FROM boxes WHERE box_no = ?', [box_no]);
  if (!box) {
    throw new AppError(`箱号 ${box_no} 不存在`, 404);
  }

  await checkBatchArchived(box.batch_no);

  const config = await getConfigByVersion(box.rule_version);
  
  if (!config.correctable_fields_whitelist.includes(field_name)) {
    throw new AppError(`字段 ${field_name} 不在可更正白名单内，允许的字段: ${config.correctable_fields_whitelist.join(', ')}`);
  }

  const { original_value } = await getOriginalValue(record_type, record_id, field_name, box_no);

  await validateProposedValue(field_name, proposed_value, record_type, config);

  if (original_value === proposed_value.toString()) {
    throw new AppError('更正后的值与原值相同，无需提交更正');
  }

  const conflictCheck = await checkPendingConflicts(box.batch_no);
  const conflictWarning = conflictCheck.count > 0 ? 1 : 0;

  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const expiresAt = moment().add(config.correction_review_time_limit, 'hours').format('YYYY-MM-DD HH:mm:ss');
  const correctionNo = generateCorrectionNo();

  const result = await run(
    `INSERT INTO correction_applications (
      correction_no, batch_no, box_no, record_type, record_id, field_name,
      original_value, proposed_value, apply_reason, applicant, applicant_type,
      status, submitted_at, expires_at, conflict_warning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      correctionNo,
      box.batch_no,
      box_no,
      record_type,
      record_id,
      field_name,
      original_value,
      proposed_value.toString(),
      apply_reason,
      applicant,
      applicant_type,
      'PENDING',
      now,
      expiresAt,
      conflictWarning
    ]
  );

  if (conflictWarning) {
    await run(
      'UPDATE correction_applications SET conflict_warning = 1 WHERE batch_no = ? AND status = ? AND id != ?',
      [box.batch_no, 'PENDING', result.lastID]
    );
  }

  await logAudit('CORRECTION_SUBMIT', box_no, applicant, {
    correction_no: correctionNo,
    field_name,
    original_value,
    proposed_value,
    apply_reason,
    has_conflict: conflictCheck.has_conflict
  });

  return getCorrectionDetail(result.lastID);
}

async function applyApprovedCorrection(correction) {
  const { record_type, record_id, field_name, proposed_value, box_no } = correction;

  switch (record_type) {
    case RECORD_TYPES.STATUS_HISTORY:
      if (field_name === 'operator') {
        await run('UPDATE status_history SET operator = ? WHERE id = ?', [proposed_value, record_id]);
      } else if (field_name === 'timestamp') {
        await run('UPDATE status_history SET timestamp = ? WHERE id = ?', [proposed_value, record_id]);
      } else if (field_name === 'custodian_type') {
        await run('UPDATE status_history SET operator_type = ? WHERE id = ?', [proposed_value, record_id]);
      }
      break;

    case RECORD_TYPES.TEMPERATURE:
      if (field_name === 'temperature') {
        const box = await get('SELECT * FROM boxes WHERE box_no = ?', [box_no]);
        const config = await getConfigByVersion(box.rule_version);
        const temp = parseFloat(proposed_value);
        const isAbnormal = temp < config.temp_min || temp > config.temp_max;
        await run(
          'UPDATE temperature_readings SET temperature = ?, is_abnormal = ? WHERE id = ?',
          [temp, isAbnormal ? 1 : 0, record_id]
        );
      } else if (field_name === 'timestamp') {
        await run('UPDATE temperature_readings SET timestamp = ? WHERE id = ?', [proposed_value, record_id]);
      } else if (field_name === 'operator' || field_name === 'custodian_type') {
        await run('UPDATE temperature_readings SET recorded_by = ? WHERE id = ?', [proposed_value, record_id]);
      }
      break;

    case RECORD_TYPES.BOX:
      if (field_name === 'current_custodian') {
        await run('UPDATE boxes SET current_custodian = ?, updated_at = ? WHERE box_no = ?',
          [proposed_value, moment().format('YYYY-MM-DD HH:mm:ss'), box_no]);
      } else if (field_name === 'custodian_type') {
        await run('UPDATE boxes SET custodian_type = ?, updated_at = ? WHERE box_no = ?',
          [proposed_value, moment().format('YYYY-MM-DD HH:mm:ss'), box_no]);
      }
      break;
  }

  await run(
    'UPDATE boxes SET updated_at = ? WHERE box_no = ?',
    [moment().format('YYYY-MM-DD HH:mm:ss'), box_no]
  );
}

async function reviewCorrection(correctionId, reviewData) {
  const { reviewer, reviewer_type, review_result, review_reason } = reviewData;

  if (!ROLE_PERMISSIONS[reviewer_type]?.can_review) {
    throw new AppError(`角色 ${reviewer_type} 没有审核更正申请的权限，可审核角色：QC`, 403);
  }

  if (!['APPROVED', 'REJECTED'].includes(review_result)) {
    throw new AppError('审核结果必须是 APPROVED 或 REJECTED');
  }

  let correction = await get('SELECT * FROM correction_applications WHERE id = ?', [correctionId]);
  if (!correction) {
    throw new AppError(`更正申请 ${correctionId} 不存在`, 404);
  }

  await ensureCorrectionNotExpired(correction);

  if (correction.status === 'EXPIRED') {
    throw new AppError('更正申请已超过审核时限，当前状态为已过期');
  }

  if (correction.status !== 'PENDING') {
    throw new AppError(`当前状态为 ${CORRECTION_STATUS[correction.status]?.label || correction.status}，不允许审核`);
  }

  if (!ROLE_PERMISSIONS[reviewer_type].reviewable_types.includes(correction.record_type)) {
    throw new AppError(`角色 ${reviewer_type} 无权审核 ${correction.record_type} 类型的更正`);
  }

  const box = await get('SELECT * FROM boxes WHERE box_no = ?', [correction.box_no]);
  await checkBatchArchived(box.batch_no);

  const conflictCheck = await checkPendingConflicts(correction.batch_no, correctionId);

  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  if (review_result === 'APPROVED') {
    await applyApprovedCorrection(correction);
  }

  await run(
    `UPDATE correction_applications SET
      status = ?,
      reviewer = ?,
      reviewer_type = ?,
      review_result = ?,
      review_reason = ?,
      reviewed_at = ?,
      conflict_warning = ?
     WHERE id = ?`,
    [
      review_result,
      reviewer,
      reviewer_type,
      review_result,
      review_reason,
      now,
      conflictCheck.has_conflict ? 1 : 0,
      correctionId
    ]
  );

  if (review_result === 'APPROVED' && conflictCheck.has_conflict) {
    await run(
      'UPDATE correction_applications SET conflict_warning = 1 WHERE batch_no = ? AND status = ? AND id != ?',
      [correction.batch_no, 'PENDING', correctionId]
    );
  }

  await logAudit(`CORRECTION_${review_result}`, correction.box_no, reviewer, {
    correction_no: correction.correction_no,
    field_name: correction.field_name,
    original_value: correction.original_value,
    proposed_value: correction.proposed_value,
    review_reason,
    other_pending_count: conflictCheck.count
  });

  return getCorrectionDetail(correctionId);
}

async function getCorrectionDetail(correctionId) {
  const correction = await get('SELECT * FROM correction_applications WHERE id = ?', [correctionId]);
  if (!correction) return null;

  await ensureCorrectionNotExpired(correction);

  const conflictCheck = await checkPendingConflicts(correction.batch_no, correctionId);

  const updated = await get('SELECT * FROM correction_applications WHERE id = ?', [correctionId]);

  return {
    ...updated,
    status_label: CORRECTION_STATUS[updated.status]?.label || updated.status,
    has_active_conflicts: conflictCheck.has_conflict,
    other_pending_count: conflictCheck.count
  };
}

async function getCorrectionByNo(correctionNo) {
  const correction = await get('SELECT * FROM correction_applications WHERE correction_no = ?', [correctionNo]);
  if (!correction) return null;
  return getCorrectionDetail(correction.id);
}

async function getCorrectionList(params = {}) {
  let sql = 'SELECT * FROM correction_applications WHERE 1=1';
  const paramsList = [];

  if (params.box_no) {
    sql += ' AND box_no = ?';
    paramsList.push(params.box_no);
  }
  if (params.batch_no) {
    sql += ' AND batch_no = ?';
    paramsList.push(params.batch_no);
  }
  if (params.status) {
    sql += ' AND status = ?';
    paramsList.push(params.status);
  }
  if (params.applicant_type) {
    sql += ' AND applicant_type = ?';
    paramsList.push(params.applicant_type);
  }
  if (params.record_type) {
    sql += ' AND record_type = ?';
    paramsList.push(params.record_type);
  }

  sql += ' ORDER BY submitted_at DESC';
  if (params.limit) {
    sql += ' LIMIT ?';
    paramsList.push(params.limit);
  }

  const corrections = await all(sql, paramsList);
  return Promise.all(corrections.map(c => getCorrectionDetail(c.id)));
}

async function getBatchCorrectionStatus(batchNo) {
  let corrections = await all(
    'SELECT * FROM correction_applications WHERE batch_no = ? ORDER BY submitted_at DESC',
    [batchNo]
  );

  for (let i = 0; i < corrections.length; i++) {
    await ensureCorrectionNotExpired(corrections[i]);
  }

  corrections = await all(
    'SELECT * FROM correction_applications WHERE batch_no = ? ORDER BY submitted_at DESC',
    [batchNo]
  );

  const now = moment();
  const activePending = corrections.filter(c => c.status === 'PENDING' && moment(c.expires_at).isAfter(now));
  const expiredPending = corrections.filter(c => c.status === 'PENDING' && moment(c.expires_at).isSameOrBefore(now));

  for (const exp of expiredPending) {
    await checkAndMarkExpired(exp);
  }

  corrections = await all(
    'SELECT * FROM correction_applications WHERE batch_no = ? ORDER BY submitted_at DESC',
    [batchNo]
  );

  const pendingCount = corrections.filter(c => c.status === 'PENDING').length;
  const approvedCount = corrections.filter(c => c.status === 'APPROVED').length;
  const rejectedCount = corrections.filter(c => c.status === 'REJECTED').length;
  const expiredCount = corrections.filter(c => c.status === 'EXPIRED').length;

  const conflictCheck = await checkPendingConflicts(batchNo);

  return {
    batch_no: batchNo,
    total_corrections: corrections.length,
    pending_count: pendingCount,
    approved_count: approvedCount,
    rejected_count: rejectedCount,
    expired_count: expiredCount,
    has_pending: pendingCount > 0,
    has_conflicts: conflictCheck.has_conflict,
    latest_correction: corrections.length > 0 ? corrections[0] : null,
    all_corrections: corrections
  };
}

async function expireOverdueCorrections() {
  const now = moment();
  const nowStr = now.format('YYYY-MM-DD HH:mm:ss');

  const toExpire = await all(
    'SELECT * FROM correction_applications WHERE status = ? AND expires_at < ?',
    ['PENDING', nowStr]
  );

  const affectedBatches = new Set();
  let expiredCount = 0;

  for (const correction of toExpire) {
    const wasExpired = await checkAndMarkExpired(correction);
    if (wasExpired) {
      expiredCount++;
      affectedBatches.add(correction.batch_no);
    }
  }

  for (const batchNo of affectedBatches) {
    const conflictCheck = await checkPendingConflicts(batchNo);
    const newWarning = conflictCheck.has_conflict ? 1 : 0;
    await run(
      'UPDATE correction_applications SET conflict_warning = ? WHERE batch_no = ? AND status = ?',
      [newWarning, batchNo, 'PENDING']
    );
  }

  return expiredCount;
}

module.exports = {
  CORRECTION_STATUS,
  RECORD_TYPES,
  ROLE_PERMISSIONS,
  submitCorrection,
  reviewCorrection,
  getCorrectionDetail,
  getCorrectionByNo,
  getCorrectionList,
  getBatchCorrectionStatus,
  checkPendingConflicts,
  checkBatchArchived,
  expireOverdueCorrections
};
