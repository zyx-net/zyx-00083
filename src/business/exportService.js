const { get, run, all } = require('../database/init');
const { getBoxDetail, getExceptionList, STATUS_FLOW, logAudit, AppError } = require('./trackingService');
const { getConfigByVersion, getActiveConfig } = require('../config/configManager');
const { getBatchCorrectionStatus, ROLE_PERMISSIONS, CORRECTION_STATUS } = require('./correctionService');
const moment = require('moment');

function generateDocNo(prefix) {
  const dateStr = moment().format('YYYYMMDD');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${dateStr}${random}`;
}

async function buildCorrectionSnapshot(batchNos) {
  const uniqueBatchNos = [...new Set(batchNos)];
  const snapshot = {
    snapshot_time: moment().format('YYYY-MM-DD HH:mm:ss'),
    snapshot_version: 1,
    batch_summaries: {},
    overall: {
      total_batches: uniqueBatchNos.length,
      total_corrections: 0,
      pending_count: 0,
      approved_count: 0,
      rejected_count: 0,
      expired_count: 0,
      conflict_count: 0
    }
  };

  for (const batchNo of uniqueBatchNos) {
    const batchStatus = await getBatchCorrectionStatus(batchNo);
    const corrections = batchStatus.all_corrections || [];
    
    const now = moment();
    const snapshotCorrections = corrections.map(c => {
      const isExpired = c.status === 'EXPIRED' || 
        (c.status === 'PENDING' && moment(c.expires_at).isSameOrBefore(now));
      const effectiveStatus = isExpired ? 'EXPIRED' : c.status;
      
      return {
        correction_no: c.correction_no,
        box_no: c.box_no,
        field_name: c.field_name,
        original_value: c.original_value,
        proposed_value: c.proposed_value,
        apply_reason: c.apply_reason,
        applicant: c.applicant,
        applicant_type: c.applicant_type,
        status: effectiveStatus,
        status_label: CORRECTION_STATUS[effectiveStatus]?.label || effectiveStatus,
        is_expired: isExpired,
        submitted_at: c.submitted_at,
        expires_at: c.expires_at,
        reviewer: c.reviewer,
        reviewer_type: c.reviewer_type,
        review_result: c.review_result,
        review_reason: c.review_reason,
        reviewed_at: c.reviewed_at,
        has_conflict: c.conflict_warning === 1
      };
    });

    const pendingCount = snapshotCorrections.filter(c => c.status === 'PENDING' && !c.is_expired).length;
    const approvedCount = snapshotCorrections.filter(c => c.status === 'APPROVED').length;
    const rejectedCount = snapshotCorrections.filter(c => c.status === 'REJECTED').length;
    const expiredCount = snapshotCorrections.filter(c => c.is_expired).length;
    const conflictCount = snapshotCorrections.filter(c => c.has_conflict).length;

    const reviewedCorrections = snapshotCorrections.filter(c => c.reviewed_at);
    const latestReview = reviewedCorrections.length > 0 
      ? reviewedCorrections.sort((a, b) => moment(b.reviewed_at).valueOf() - moment(a.reviewed_at).valueOf())[0]
      : null;

    snapshot.batch_summaries[batchNo] = {
      batch_no: batchNo,
      total_corrections: snapshotCorrections.length,
      pending_count: pendingCount,
      approved_count: approvedCount,
      rejected_count: rejectedCount,
      expired_count: expiredCount,
      conflict_count: conflictCount,
      has_conflicts: conflictCount > 0,
      latest_reviewer: latestReview ? latestReview.reviewer : null,
      latest_reviewer_type: latestReview ? latestReview.reviewer_type : null,
      latest_review_reason: latestReview ? latestReview.review_reason : null,
      latest_review_result: latestReview ? latestReview.review_result : null,
      latest_reviewed_at: latestReview ? latestReview.reviewed_at : null,
      corrections: snapshotCorrections
    };

    snapshot.overall.total_corrections += snapshotCorrections.length;
    snapshot.overall.pending_count += pendingCount;
    snapshot.overall.approved_count += approvedCount;
    snapshot.overall.rejected_count += rejectedCount;
    snapshot.overall.expired_count += expiredCount;
    snapshot.overall.conflict_count += conflictCount;
  }

  return snapshot;
}

async function exportHandoverDocument(boxNo, operator, options = {}) {
  const box = await getBoxDetail(boxNo);
  if (!box) {
    throw new AppError(`箱号 ${boxNo} 不存在`, 404);
  }

  const config = await getConfigByVersion(box.rule_version);
  const docNo = options.newDocNo || generateDocNo('HJD');
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  const handoverContent = {
    doc_no: docNo,
    doc_type: 'HANDOVER_ORDER',
    box_no: boxNo,
    batch_no: box.batch_no,
    created_at: now,
    created_by: operator,
    rule_version: box.rule_version,
    temperature_threshold: {
      min: config.temp_min,
      max: config.temp_max
    },
    delivery_time_limit: `${config.delivery_time_limit}分钟`,
    box_info: {
      status: box.status,
      status_label: box.status_label,
      current_custodian: box.current_custodian,
      custodian_type: box.custodian_type,
      meal_items: box.meal_items,
      meal_count: box.meal_items.length
    },
    status_history: box.status_history.map(h => ({
      status: h.to_status,
      status_label: STATUS_FLOW[h.to_status]?.label || h.to_status,
      operator: h.operator,
      operator_type: h.operator_type,
      timestamp: h.timestamp,
      remark: h.remark
    })),
    temperature_readings: box.temperature_readings.map(t => ({
      temperature: t.temperature,
      timestamp: t.timestamp,
      recorded_by: t.recorded_by,
      is_abnormal: !!t.is_abnormal
    })),
    handover_signature: {
      from: box.current_custodian,
      to: operator,
      sign_time: now
    }
  };

  const correctionSnapshot = await buildCorrectionSnapshot([box.batch_no]);
  handoverContent.correction_snapshot = correctionSnapshot;

  const isReexport = options.isReexport || false;
  const parentDocNo = options.parentDocNo || null;
  const reexportReason = options.reexportReason || null;
  const version = options.version || 1;

  await run(
    `INSERT INTO exported_documents (doc_type, doc_no, box_no, content, created_at, created_by, correction_snapshot, parent_doc_no, is_reexport, reexport_reason, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'HANDOVER_ORDER',
      docNo,
      boxNo,
      JSON.stringify(handoverContent),
      now,
      operator,
      JSON.stringify(correctionSnapshot),
      parentDocNo,
      isReexport ? 1 : 0,
      reexportReason,
      version
    ]
  );

  return {
    ...handoverContent,
    printable_format: generatePrintableHandover(handoverContent)
  };
}

function generatePrintableHandover(content) {
  const itemsText = content.box_info.meal_items
    .map((item, idx) => `${idx + 1}. ${item.name} x${item.quantity}`)
    .join('\n');

  const historyText = content.status_history
    .map(h => `[${h.timestamp}] ${h.status_label} - ${h.operator}`)
    .join('\n');

  const tempText = content.temperature_readings.length > 0
    ? content.temperature_readings
        .map(t => `[${t.timestamp}] ${t.temperature}°C ${t.is_abnormal ? '(异常)' : ''}`)
        .join('\n')
    : '暂无温度记录';

  let correctionText = '';
  if (content.correction_snapshot) {
    const o = content.correction_snapshot.overall;
    const parts = [];
    if (o.total_corrections === 0) {
      parts.push('无更正记录');
    } else {
      if (o.pending_count > 0) parts.push(`待审核${o.pending_count}条`);
      if (o.approved_count > 0) parts.push(`已通过${o.approved_count}条`);
      if (o.rejected_count > 0) parts.push(`已驳回${o.rejected_count}条`);
      if (o.expired_count > 0) parts.push(`已过期${o.expired_count}条`);
      if (o.conflict_count > 0) parts.push(`冲突${o.conflict_count}条`);
    }
    
    correctionText = `\n-----------------------------------------\n【更正快照】\n快照时间: ${content.correction_snapshot.snapshot_time}\n更正状态: ${parts.join(', ')}\n`;
    
    const summaries = Object.values(content.correction_snapshot.batch_summaries);
    for (const summary of summaries) {
      if (summary.latest_reviewer) {
        correctionText += `最近审核: ${summary.latest_reviewer} [${summary.latest_review_result === 'APPROVED' ? '通过' : '驳回'}] - ${summary.latest_review_reason || '无原因'}\n`;
      }
    }
  }

  return `
=========================================
         冷链餐盒交接单
=========================================
单据编号: ${content.doc_no}
生成时间: ${content.created_at}
规则版本: ${content.rule_version}

-----------------------------------------
【餐盒信息】
箱号: ${content.box_no}
批次: ${content.batch_no}
当前状态: ${content.box_info.status_label}
当前保管人: ${content.box_info.current_custodian}
餐品数量: ${content.box_info.meal_count} 份

-----------------------------------------
【温控要求】
温度范围: ${content.temperature_threshold.min}°C ~ ${content.temperature_threshold.max}°C
配送时限: ${content.delivery_time_limit}

-----------------------------------------
【餐品明细】
${itemsText}

-----------------------------------------
【流转记录】
${historyText}

-----------------------------------------
【温度记录】
${tempText}${correctionText}
-----------------------------------------
【交接签署】
移交人: ${content.handover_signature.from}
接收人: ${content.handover_signature.to}
签署时间: ${content.handover_signature.sign_time}

=========================================
`;
}

async function exportExceptionList(operator, options = {}) {
  const exceptions = await getExceptionList();
  const docNo = options.newDocNo || generateDocNo('YCD');
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

  const batchNos = [...new Set(exceptions.map(e => e.batch_no))];
  const batchStatusCache = {};
  for (const e of exceptions) {
    if (!batchStatusCache[e.batch_no]) {
      batchStatusCache[e.batch_no] = await getBatchCorrectionStatus(e.batch_no);
    }
  }

  const exceptionContent = {
    doc_no: docNo,
    doc_type: 'EXCEPTION_LIST',
    created_at: now,
    created_by: operator,
    total_count: exceptions.length,
    exceptions: exceptions.map(e => {
      const batchStatus = batchStatusCache[e.batch_no];
      const boxCorrections = batchStatus.all_corrections.filter(c => c.box_no === e.box_no);
      const now = moment();
      const pendingCount = boxCorrections.filter(c => c.status === 'PENDING' && moment(c.expires_at).isAfter(now)).length;
      const approvedCount = boxCorrections.filter(c => c.status === 'APPROVED').length;
      const rejectedCount = boxCorrections.filter(c => c.status === 'REJECTED').length;
      const expiredCount = boxCorrections.filter(c => c.status === 'EXPIRED' || 
        (c.status === 'PENDING' && moment(c.expires_at).isSameOrBefore(now))).length;

      const latestCorrection = boxCorrections.length > 0 ? boxCorrections[0] : null;
      let latestStatusLabel = '已过期';
      if (latestCorrection) {
        if (latestCorrection.status === 'PENDING' && moment(latestCorrection.expires_at).isAfter(now)) {
          latestStatusLabel = '待审核';
        } else if (latestCorrection.status === 'APPROVED') {
          latestStatusLabel = '已通过';
        } else if (latestCorrection.status === 'REJECTED') {
          latestStatusLabel = '已驳回';
        }
      }

      return {
        box_no: e.box_no,
        batch_no: e.batch_no,
        status: e.status,
        status_label: e.status_label,
        current_custodian: e.current_custodian,
        exception_reason: e.exception_reason,
        meal_items: e.meal_items,
        isolated_at: e.isolated_at,
        archived_at: e.archived_at,
        correction_status: {
          has_pending: pendingCount > 0,
          pending_count: pendingCount,
          approved_count: approvedCount,
          rejected_count: rejectedCount,
          expired_count: expiredCount,
          has_conflicts: batchStatus.has_conflicts,
          latest_correction: latestCorrection ? {
            correction_no: latestCorrection.correction_no,
            status: latestCorrection.status === 'PENDING' && moment(latestCorrection.expires_at).isSameOrBefore(now) ? 'EXPIRED' : latestCorrection.status,
            status_label: latestStatusLabel,
            submitted_at: latestCorrection.submitted_at,
            field_name: latestCorrection.field_name,
            expires_at: latestCorrection.expires_at
          } : null
        }
      };
    })
  };

  const correctionSnapshot = await buildCorrectionSnapshot(batchNos);
  exceptionContent.correction_snapshot = correctionSnapshot;

  const isReexport = options.isReexport || false;
  const parentDocNo = options.parentDocNo || null;
  const reexportReason = options.reexportReason || null;
  const version = options.version || 1;

  await run(
    `INSERT INTO exported_documents (doc_type, doc_no, box_no, content, created_at, created_by, correction_snapshot, parent_doc_no, is_reexport, reexport_reason, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'EXCEPTION_LIST',
      docNo,
      null,
      JSON.stringify(exceptionContent),
      now,
      operator,
      JSON.stringify(correctionSnapshot),
      parentDocNo,
      isReexport ? 1 : 0,
      reexportReason,
      version
    ]
  );

  return {
    ...exceptionContent,
    printable_format: generatePrintableException(exceptionContent)
  };
}

function generatePrintableException(content) {
  const listText = content.exceptions
    .map((e, idx) => {
      const cs = e.correction_status;
      let correctionText = '';
      if (cs) {
        const statusParts = [];
        if (cs.pending_count > 0) statusParts.push(`待审${cs.pending_count}条`);
        if (cs.approved_count > 0) statusParts.push(`已通过${cs.approved_count}条`);
        if (cs.rejected_count > 0) statusParts.push(`已驳回${cs.rejected_count}条`);
        if (cs.has_conflicts) statusParts.push('⚠️存在冲突');
        if (cs.expired_count > 0) statusParts.push(`已过期${cs.expired_count}条`);
        
        correctionText = statusParts.length > 0 ? `\n   更正状态: ${statusParts.join(', ')}` : '';
        if (cs.latest_correction) {
          correctionText += `\n   最新更正: ${cs.latest_correction.correction_no} [${cs.latest_correction.status_label}] ${cs.latest_correction.field_name}`;
          if (cs.latest_correction.status === 'EXPIRED') {
            correctionText += ` (过期时间: ${cs.latest_correction.expires_at})`;
          }
        }
      }
      return `
${idx + 1}. 箱号: ${e.box_no}
   批次: ${e.batch_no}
   状态: ${e.status_label}
   当前保管人: ${e.current_custodian}
   异常原因: ${e.exception_reason || '未记录'}
   隔离时间: ${e.isolated_at || '未记录'}
   餐品: ${e.meal_items.map(m => `${m.name}x${m.quantity}`).join(', ')}${correctionText}
`;
    })
    .join('\n');

  let snapshotText = '';
  if (content.correction_snapshot) {
    const o = content.correction_snapshot.overall;
    const parts = [];
    if (o.total_corrections === 0) {
      parts.push('无更正记录');
    } else {
      if (o.pending_count > 0) parts.push(`待审核${o.pending_count}条`);
      if (o.approved_count > 0) parts.push(`已通过${o.approved_count}条`);
      if (o.rejected_count > 0) parts.push(`已驳回${o.rejected_count}条`);
      if (o.expired_count > 0) parts.push(`已过期${o.expired_count}条`);
      if (o.conflict_count > 0) parts.push(`冲突${o.conflict_count}条`);
    }
    
    snapshotText = `\n-----------------------------------------\n【更正快照汇总】\n快照时间: ${content.correction_snapshot.snapshot_time}\n汇总: ${parts.join(', ')}\n`;
    
    const summaries = Object.values(content.correction_snapshot.batch_summaries);
    for (const summary of summaries) {
      if (summary.latest_reviewer) {
        snapshotText += `批次${summary.batch_no} 最近审核: ${summary.latest_reviewer} [${summary.latest_review_result === 'APPROVED' ? '通过' : '驳回'}]\n`;
      }
    }
  }

  return `
=========================================
         异常餐盒清单
=========================================
单据编号: ${content.doc_no}
生成时间: ${content.created_at}
异常总数: ${content.total_count} 箱

-----------------------------------------
【异常明细】
${listText || '无异常记录'}${snapshotText}
=========================================
`;
}

async function getExportedDocument(docNo) {
  const doc = await get('SELECT * FROM exported_documents WHERE doc_no = ?', [docNo]);
  if (!doc) return null;
  return {
    ...doc,
    content: JSON.parse(doc.content),
    correction_snapshot: doc.correction_snapshot ? JSON.parse(doc.correction_snapshot) : null,
    is_reexport: doc.is_reexport === 1
  };
}

async function getExportHistory(boxNo = null) {
  let sql = 'SELECT * FROM exported_documents';
  let params = [];
  if (boxNo) {
    sql += ' WHERE box_no = ?';
    params = [boxNo];
  }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  
  const docs = await all(sql, params);
  return docs.map(d => ({
    ...d,
    content: JSON.parse(d.content),
    correction_snapshot: d.correction_snapshot ? JSON.parse(d.correction_snapshot) : null,
    is_reexport: d.is_reexport === 1
  }));
}

async function reexportDocument(docNo, operator, operatorType, reexportReason) {
  const activeConfig = await getActiveConfig();
  if (!activeConfig.allow_reexport) {
    throw new AppError('系统已关闭重新导出功能，请联系管理员开启', 403);
  }

  if (!ROLE_PERMISSIONS[operatorType]?.can_review) {
    throw new AppError(`角色 ${operatorType} 没有重新导出的权限，仅 QC 可执行重新导出`, 403);
  }

  if (!reexportReason || reexportReason.trim().length === 0) {
    throw new AppError('重新导出必须提供原因', 400);
  }

  const originalDoc = await get('SELECT * FROM exported_documents WHERE doc_no = ?', [docNo]);
  if (!originalDoc) {
    throw new AppError(`单据号 ${docNo} 不存在`, 404);
  }

  const existingExports = await all(
    'SELECT * FROM exported_documents WHERE parent_doc_no = ? OR doc_no = ? ORDER BY version DESC',
    [docNo, docNo]
  );
  const maxVersion = existingExports.reduce((max, d) => Math.max(max, d.version || 1), 0);
  const newVersion = maxVersion + 1;

  const newDocNo = generateDocNo(originalDoc.doc_type === 'HANDOVER_ORDER' ? 'HJD' : 'YCD');

  let newDoc;
  if (originalDoc.doc_type === 'HANDOVER_ORDER') {
    newDoc = await exportHandoverDocument(originalDoc.box_no, operator, {
      newDocNo,
      isReexport: true,
      parentDocNo: docNo,
      reexportReason,
      version: newVersion
    });
  } else if (originalDoc.doc_type === 'EXCEPTION_LIST') {
    newDoc = await exportExceptionList(operator, {
      newDocNo,
      isReexport: true,
      parentDocNo: docNo,
      reexportReason,
      version: newVersion
    });
  } else {
    throw new AppError(`不支持的单据类型: ${originalDoc.doc_type}`, 400);
  }

  const oldSnapshot = originalDoc.correction_snapshot ? JSON.parse(originalDoc.correction_snapshot) : null;
  const newSnapshot = newDoc.correction_snapshot;

  let correctionSummary = '无更正信息';
  if (oldSnapshot && newSnapshot) {
    const oldTotal = oldSnapshot.overall.total_corrections;
    const newTotal = newSnapshot.overall.total_corrections;
    const oldPending = oldSnapshot.overall.pending_count;
    const newPending = newSnapshot.overall.pending_count;
    const oldApproved = oldSnapshot.overall.approved_count;
    const newApproved = newSnapshot.overall.approved_count;
    
    const changes = [];
    if (oldTotal !== newTotal) changes.push(`更正总数: ${oldTotal} → ${newTotal}`);
    if (oldPending !== newPending) changes.push(`待审核: ${oldPending} → ${newPending}`);
    if (oldApproved !== newApproved) changes.push(`已通过: ${oldApproved} → ${newApproved}`);
    
    correctionSummary = changes.length > 0 ? changes.join('; ') : '更正状态无变化';
  }

  await logAudit('DOCUMENT_REEXPORT', originalDoc.box_no, operator, {
    old_doc_no: docNo,
    new_doc_no: newDocNo,
    doc_type: originalDoc.doc_type,
    old_version: maxVersion,
    new_version: newVersion,
    reexport_reason: reexportReason,
    operator_type: operatorType,
    correction_summary: correctionSummary,
    snapshot_time_old: oldSnapshot ? oldSnapshot.snapshot_time : null,
    snapshot_time_new: newSnapshot ? newSnapshot.snapshot_time : null
  });

  return {
    old_doc_no: docNo,
    new_doc_no: newDocNo,
    version: newVersion,
    doc_type: originalDoc.doc_type,
    correction_summary: correctionSummary,
    document: newDoc
  };
}

module.exports = {
  exportHandoverDocument,
  exportExceptionList,
  getExportedDocument,
  getExportHistory,
  reexportDocument,
  buildCorrectionSnapshot
};
