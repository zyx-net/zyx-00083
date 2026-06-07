const { get, run, all } = require('../database/init');
const { getBoxDetail, getExceptionList, STATUS_FLOW } = require('./trackingService');
const { getConfigByVersion } = require('../config/configManager');
const { getBatchCorrectionStatus } = require('./correctionService');
const moment = require('moment');

function generateDocNo(prefix) {
  const dateStr = moment().format('YYYYMMDD');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${dateStr}${random}`;
}

async function exportHandoverDocument(boxNo, operator) {
  const box = await getBoxDetail(boxNo);
  if (!box) {
    throw new Error(`箱号 ${boxNo} 不存在`);
  }

  const config = await getConfigByVersion(box.rule_version);
  const docNo = generateDocNo('HJD');
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

  await run(
    `INSERT INTO exported_documents (doc_type, doc_no, box_no, content, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      'HANDOVER_ORDER',
      docNo,
      boxNo,
      JSON.stringify(handoverContent),
      now,
      operator
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
${tempText}

-----------------------------------------
【交接签署】
移交人: ${content.handover_signature.from}
接收人: ${content.handover_signature.to}
签署时间: ${content.handover_signature.sign_time}

=========================================
`;
}

async function exportExceptionList(operator) {
  const exceptions = await getExceptionList();
  const docNo = generateDocNo('YCD');
  const now = moment().format('YYYY-MM-DD HH:mm:ss');

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
      const pendingCount = boxCorrections.filter(c => c.status === 'PENDING').length;
      const approvedCount = boxCorrections.filter(c => c.status === 'APPROVED').length;
      const rejectedCount = boxCorrections.filter(c => c.status === 'REJECTED').length;

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
          has_conflicts: batchStatus.has_conflicts,
          latest_correction: boxCorrections.length > 0 ? {
            correction_no: boxCorrections[0].correction_no,
            status: boxCorrections[0].status,
            status_label: boxCorrections[0].status === 'PENDING' ? '待审核' :
                         boxCorrections[0].status === 'APPROVED' ? '已通过' :
                         boxCorrections[0].status === 'REJECTED' ? '已驳回' : '已过期',
            submitted_at: boxCorrections[0].submitted_at,
            field_name: boxCorrections[0].field_name
          } : null
        }
      };
    })
  };

  await run(
    `INSERT INTO exported_documents (doc_type, doc_no, content, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [
      'EXCEPTION_LIST',
      docNo,
      JSON.stringify(exceptionContent),
      now,
      operator
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
        
        correctionText = statusParts.length > 0 ? `\n   更正状态: ${statusParts.join(', ')}` : '';
        if (cs.latest_correction) {
          correctionText += `\n   最新更正: ${cs.latest_correction.correction_no} [${cs.latest_correction.status_label}] ${cs.latest_correction.field_name}`;
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

  return `
=========================================
         异常餐盒清单
=========================================
单据编号: ${content.doc_no}
生成时间: ${content.created_at}
异常总数: ${content.total_count} 箱

-----------------------------------------
【异常明细】
${listText || '无异常记录'}

=========================================
`;
}

async function getExportedDocument(docNo) {
  const doc = await get('SELECT * FROM exported_documents WHERE doc_no = ?', [docNo]);
  if (!doc) return null;
  return {
    ...doc,
    content: JSON.parse(doc.content)
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
    content: JSON.parse(d.content)
  }));
}

module.exports = {
  exportHandoverDocument,
  exportExceptionList,
  getExportedDocument,
  getExportHistory
};
