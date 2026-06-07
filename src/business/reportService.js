const { get, run, all } = require('../database/init');
const { getBoxList, STATUS_FLOW, logAudit, AppError } = require('./trackingService');
const { getBatchCorrectionStatus, CORRECTION_STATUS, ROLE_PERMISSIONS } = require('./correctionService');
const { getActiveConfig, getConfigByVersion, DEFAULT_REPORT_VISIBLE_FIELDS } = require('../config/configManager');
const moment = require('moment');

const BASIC_FIELDS = [
  'report_no', 'batch_no', 'total_boxes', 'status_summary',
  'config_version', 'generated_at', 'generated_by', 'has_conflicts'
];

const AUTHORIZED_ROLES = ['QC', 'ADMIN', 'SYSTEM'];

function generateReportNo() {
  const dateStr = moment().format('YYYYMMDD');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `BGR${dateStr}${random}`;
}

function isAuthorized(operatorType) {
  return AUTHORIZED_ROLES.includes(operatorType);
}

async function checkReportEnabled() {
  const config = await getActiveConfig();
  if (!config.report_enabled) {
    throw new AppError('批次复盘报告功能已关闭，请联系管理员开启', 403);
  }
  return config;
}

async function detectConflicts(batchNo, boxes) {
  const warnings = [];
  const details = [];
  const now = moment();

  const correctionStatus = await getBatchCorrectionStatus(batchNo);
  
  if (correctionStatus.pending_count > 0) {
    const pendingCorrections = correctionStatus.all_corrections
      .filter(c => c.status === 'PENDING' && moment(c.expires_at).isAfter(now))
      .map(c => ({
        correction_no: c.correction_no,
        box_no: c.box_no,
        field_name: c.field_name,
        applicant: c.applicant,
        submitted_at: c.submitted_at,
        expires_at: c.expires_at
      }));

    warnings.push({
      type: 'PENDING_CORRECTIONS',
      severity: 'WARNING',
      message: `该批次存在 ${correctionStatus.pending_count} 条待审核的更正申请`
    });

    details.push({
      type: 'PENDING_CORRECTIONS',
      severity: 'WARNING',
      message: `该批次存在 ${correctionStatus.pending_count} 条待审核的更正申请`,
      details: {
        pending_count: correctionStatus.pending_count,
        pending_corrections: pendingCorrections
      }
    });
  }

  const exportedDocs = await all(
    `SELECT doc_no, doc_type, box_no, version, parent_doc_no, is_reexport 
     FROM exported_documents 
     WHERE box_no IN (SELECT box_no FROM boxes WHERE batch_no = ?)
     ORDER BY created_at DESC`,
    [batchNo]
  );

  const versionGroups = {};
  for (const doc of exportedDocs) {
    const key = doc.parent_doc_no || doc.doc_no;
    if (!versionGroups[key]) {
      versionGroups[key] = [];
    }
    versionGroups[key].push(doc);
  }

  const mismatchedVersions = Object.entries(versionGroups)
    .filter(([_, docs]) => docs.length > 1)
    .map(([key, docs]) => ({
      base_doc_no: key,
      versions: docs.map(d => ({
        doc_no: d.doc_no,
        version: d.version,
        is_reexport: d.is_reexport === 1,
        box_no: d.box_no,
        doc_type: d.doc_type
      }))
    }));

  if (mismatchedVersions.length > 0) {
    warnings.push({
      type: 'EXPORT_VERSION_MISMATCH',
      severity: 'INFO',
      message: `该批次存在 ${mismatchedVersions.length} 组不同版本的导出单据`
    });

    details.push({
      type: 'EXPORT_VERSION_MISMATCH',
      severity: 'INFO',
      message: `该批次存在 ${mismatchedVersions.length} 组不同版本的导出单据`,
      details: {
        mismatched_count: mismatchedVersions.length,
        mismatched_groups: mismatchedVersions
      }
    });
  }

  return {
    has_conflicts: warnings.length > 0,
    conflict_warnings: warnings,
    conflict_details: details
  };
}

async function buildStatusSummary(boxes) {
  const summary = {};
  for (const box of boxes) {
    const status = box.status;
    if (!summary[status]) {
      summary[status] = 0;
    }
    summary[status]++;
    summary[`${status}_label`] = STATUS_FLOW[status]?.label || status;
  }
  return summary;
}

async function buildHandoverTimestamps(boxes) {
  const timestamps = {};
  
  for (const box of boxes) {
    const history = await all(
      'SELECT to_status, timestamp FROM status_history WHERE box_no = ? ORDER BY timestamp ASC',
      [box.box_no]
    );

    for (const h of history) {
      const status = h.to_status;
      if (!timestamps[status]) {
        timestamps[status] = { earliest: h.timestamp, latest: h.timestamp, count: 0 };
      }
      if (h.timestamp < timestamps[status].earliest) {
        timestamps[status].earliest = h.timestamp;
      }
      if (h.timestamp > timestamps[status].latest) {
        timestamps[status].latest = h.timestamp;
      }
      timestamps[status].count++;
    }
  }

  return timestamps;
}

async function buildTemperatureAbnormalities(boxes) {
  const abnormalities = [];
  
  for (const box of boxes) {
    const temps = await all(
      'SELECT temperature, timestamp, recorded_by FROM temperature_readings WHERE box_no = ? AND is_abnormal = 1 ORDER BY timestamp ASC',
      [box.box_no]
    );
    
    for (const t of temps) {
      abnormalities.push({
        box_no: box.box_no,
        temperature: t.temperature,
        timestamp: t.timestamp,
        recorded_by: t.recorded_by
      });
    }
  }

  return abnormalities;
}

async function buildIsolationReasons(boxes) {
  const isolatedBoxes = boxes.filter(b => b.is_exception === 1);
  return isolatedBoxes.map(b => ({
    box_no: b.box_no,
    exception_reason: b.exception_reason,
    status: b.status,
    status_label: b.status_label
  }));
}

async function buildCorrectionsSummary(batchNo) {
  const status = await getBatchCorrectionStatus(batchNo);
  return {
    total: status.total_corrections,
    pending: status.pending_count,
    approved: status.approved_count,
    rejected: status.rejected_count,
    expired: status.expired_count,
    has_pending: status.has_pending,
    has_conflicts: status.has_conflicts
  };
}

async function buildExportedDocuments(boxes) {
  const boxNos = boxes.map(b => b.box_no);
  if (boxNos.length === 0) return [];

  const placeholders = boxNos.map(() => '?').join(',');
  const docs = await all(
    `SELECT doc_no, doc_type, box_no, created_at, created_by, version, is_reexport, parent_doc_no
     FROM exported_documents 
     WHERE box_no IN (${placeholders}) OR (doc_type = 'EXCEPTION_LIST' AND id IN (
       SELECT id FROM exported_documents WHERE doc_type = 'EXCEPTION_LIST'
     ))
     ORDER BY created_at DESC`,
    boxNos
  );

  const docTypeLabels = {
    HANDOVER_ORDER: '交接单',
    EXCEPTION_LIST: '异常清单'
  };

  return docs.map(d => ({
    doc_no: d.doc_no,
    doc_type: d.doc_type,
    doc_type_label: docTypeLabels[d.doc_type] || d.doc_type,
    box_no: d.box_no,
    created_at: d.created_at,
    created_by: d.created_by,
    version: d.version,
    is_reexport: d.is_reexport === 1,
    parent_doc_no: d.parent_doc_no
  }));
}

async function buildSnapshotData(batchNo, boxes, configVersion) {
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const config = await getConfigByVersion(configVersion);

  return {
    snapshot_time: now,
    snapshot_version: 1,
    config_version: configVersion,
    config_snapshot: {
      temp_min: config.temp_min,
      temp_max: config.temp_max,
      delivery_time_limit: config.delivery_time_limit,
      report_visible_fields: config.report_visible_fields
    },
    boxes: boxes.map(b => ({
      box_no: b.box_no,
      status: b.status,
      status_label: b.status_label,
      current_custodian: b.current_custodian,
      custodian_type: b.custodian_type,
      is_exception: b.is_exception === 1,
      exception_reason: b.exception_reason,
      created_at: b.created_at,
      updated_at: b.updated_at
    }))
  };
}

function filterFieldsByRole(report, operatorType, config) {
  if (isAuthorized(operatorType)) {
    const visibleFields = config.report_visible_fields || DEFAULT_REPORT_VISIBLE_FIELDS;
    const filtered = { report_no: report.report_no };
    for (const field of visibleFields) {
      if (report[field] !== undefined) {
        filtered[field] = report[field];
      }
    }
    filtered._meta = {
      is_authorized: true,
      visible_fields: visibleFields
    };
    return filtered;
  }

  const filtered = {};
  for (const field of BASIC_FIELDS) {
    if (report[field] !== undefined) {
      filtered[field] = report[field];
    }
  }
  filtered._meta = {
    is_authorized: false,
    visible_fields: BASIC_FIELDS
  };
  return filtered;
}

async function generateBatchReport(batchNo, operator, operatorType) {
  const config = await checkReportEnabled();

  const boxes = await getBoxList({ batch_no: batchNo });
  if (boxes.length === 0) {
    throw new AppError(`批次 ${batchNo} 不存在或没有餐盒`, 404);
  }

  const conflicts = await detectConflicts(batchNo, boxes);
  const statusSummary = await buildStatusSummary(boxes);
  const handoverTimestamps = await buildHandoverTimestamps(boxes);
  const tempAbnormalities = await buildTemperatureAbnormalities(boxes);
  const isolationReasons = await buildIsolationReasons(boxes);
  const correctionsSummary = await buildCorrectionsSummary(batchNo);
  const exportedDocuments = await buildExportedDocuments(boxes);
  const snapshotData = await buildSnapshotData(batchNo, boxes, config.version);

  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  const reportNo = generateReportNo();

  const reportContent = {
    report_no: reportNo,
    batch_no: batchNo,
    total_boxes: boxes.length,
    status_summary: statusSummary,
    handover_timestamps: handoverTimestamps,
    temperature_abnormalities: tempAbnormalities,
    isolation_reasons: isolationReasons,
    corrections_summary: correctionsSummary,
    exported_documents: exportedDocuments,
    conflict_warnings: conflicts.conflict_warnings,
    config_version: config.version,
    generated_at: now,
    generated_by: operator,
    has_conflicts: conflicts.has_conflicts,
    conflict_details: conflicts.conflict_details
  };

  await run(
    `INSERT INTO batch_reports (
      report_no, batch_no, config_version, report_content, snapshot_data,
      generated_at, generated_by, generated_by_type, has_conflicts, conflict_warnings
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reportNo,
      batchNo,
      config.version,
      JSON.stringify(reportContent),
      JSON.stringify(snapshotData),
      now,
      operator,
      operatorType,
      conflicts.has_conflicts ? 1 : 0,
      JSON.stringify(conflicts.conflict_warnings)
    ]
  );

  await logAudit('BATCH_REPORT_GENERATE', null, operator, {
    report_no: reportNo,
    batch_no: batchNo,
    total_boxes: boxes.length,
    config_version: config.version,
    has_conflicts: conflicts.has_conflicts,
    conflict_types: conflicts.conflict_warnings.map(w => w.type),
    operator_type: operatorType
  });

  const filteredReport = filterFieldsByRole(reportContent, operatorType, config);
  filteredReport.snapshot_data = snapshotData;

  return {
    ...filteredReport,
    message: conflicts.has_conflicts
      ? '报告生成成功，存在冲突提示，请查看 conflict_warnings'
      : '报告生成成功'
  };
}

async function getReportList(params = {}) {
  let sql = 'SELECT * FROM batch_reports WHERE 1=1';
  const paramsList = [];

  if (params.batch_no) {
    sql += ' AND batch_no = ?';
    paramsList.push(params.batch_no);
  }
  if (params.config_version) {
    sql += ' AND config_version = ?';
    paramsList.push(params.config_version);
  }

  sql += ' ORDER BY generated_at DESC LIMIT 50';

  const reports = await all(sql, paramsList);
  const config = await getActiveConfig();
  const operatorType = params.operator_type || 'STORE';

  return reports.map(r => {
    const content = JSON.parse(r.report_content);
    return filterFieldsByRole(content, operatorType, config);
  });
}

async function getReportDetail(reportNo, operatorType) {
  const report = await get('SELECT * FROM batch_reports WHERE report_no = ?', [reportNo]);
  if (!report) {
    throw new AppError(`报告 ${reportNo} 不存在`, 404);
  }

  const config = await getActiveConfig();

  if (!isAuthorized(operatorType)) {
    await logAudit('BATCH_REPORT_UNAUTHORIZED_ACCESS', null, 'UNKNOWN', {
      report_no: reportNo,
      batch_no: report.batch_no,
      operator_type: operatorType,
      error: '非QC或管理员角色尝试访问完整报告'
    }, false, '权限不足：仅 QC 或管理员角色可查看完整报告内容');

    throw new AppError(
      '权限不足：仅 QC 或管理员角色可查看完整报告内容。您当前仅可查看基础字段。',
      403
    );
  }

  const content = JSON.parse(report.report_content);
  const snapshot = JSON.parse(report.snapshot_data);
  const filtered = filterFieldsByRole(content, operatorType, config);
  filtered.snapshot_data = snapshot;

  return filtered;
}

async function getReportBasic(reportNo, operatorType) {
  const report = await get('SELECT * FROM batch_reports WHERE report_no = ?', [reportNo]);
  if (!report) {
    throw new AppError(`报告 ${reportNo} 不存在`, 404);
  }

  const config = await getActiveConfig();
  const content = JSON.parse(report.report_content);

  return filterFieldsByRole(content, operatorType, config);
}

module.exports = {
  generateBatchReport,
  getReportList,
  getReportDetail,
  getReportBasic,
  isAuthorized,
  BASIC_FIELDS,
  AUTHORIZED_ROLES
};
