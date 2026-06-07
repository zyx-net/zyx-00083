const express = require('express');
const router = express.Router();
const { validate, asyncHandler } = require('../middleware/errorHandler');
const {
  createBox,
  updateBoxStatus,
  recordTemperature,
  getBoxDetail,
  getBoxList,
  getAuditLogs,
  getExceptionList,
  STATUS_FLOW,
  CUSTODIAN_TYPES
} = require('../business/trackingService');
const {
  getActiveConfig,
  getAllConfigs,
  addNewConfig
} = require('../config/configManager');
const {
  exportHandoverDocument,
  exportExceptionList,
  getExportedDocument,
  getExportHistory,
  reexportDocument
} = require('../business/exportService');
const {
  submitCorrection,
  reviewCorrection,
  getCorrectionDetail,
  getCorrectionByNo,
  getCorrectionList,
  getBatchCorrectionStatus,
  CORRECTION_STATUS
} = require('../business/correctionService');

router.get('/health', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'running',
      timestamp: new Date().toISOString(),
      service: 'cold-chain-meal-tracking-api',
      version: '1.0.0'
    }
  });
}));

router.get('/config', asyncHandler(async (req, res) => {
  const config = await getActiveConfig();
  res.json({
    success: true,
    data: config
  });
}));

router.get('/configs', asyncHandler(async (req, res) => {
  const configs = await getAllConfigs();
  res.json({
    success: true,
    data: configs
  });
}));

router.post('/config', validate('exportRequest'), asyncHandler(async (req, res) => {
  const { operator, ...configData } = req.body;
  const id = await addNewConfig(configData, operator);
  res.json({
    success: true,
    data: { id, message: '配置更新成功' }
  });
}));

router.get('/boxes', asyncHandler(async (req, res) => {
  const boxes = await getBoxList(req.query);
  res.json({
    success: true,
    data: boxes
  });
}));

router.get('/boxes/:box_no', asyncHandler(async (req, res) => {
  const box = await getBoxDetail(req.params.box_no);
  if (!box) {
    return res.status(404).json({
      success: false,
      error: `箱号 ${req.params.box_no} 不存在`
    });
  }
  res.json({
    success: true,
    data: box
  });
}));

router.post('/boxes', validate('createBox'), asyncHandler(async (req, res) => {
  const box = await createBox(req.validatedBody);
  res.status(201).json({
    success: true,
    data: box,
    message: '餐盒建档成功'
  });
}));

router.put('/boxes/:box_no/status/:status', validate('statusUpdate'), asyncHandler(async (req, res) => {
  const { box_no, status } = req.params;
  const validStatuses = Object.keys(STATUS_FLOW);
  
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      error: `无效的目标状态: ${status}，有效状态: ${validStatuses.join(', ')}`
    });
  }

  const box = await updateBoxStatus(box_no, status, req.validatedBody.operator, req.validatedBody.operator_type, req.validatedBody);
  
  res.json({
    success: true,
    data: box,
    message: `状态更新为: ${STATUS_FLOW[status]?.label || status}`
  });
}));

router.post('/temperature', validate('temperatureRecord'), asyncHandler(async (req, res) => {
  const { box_no, temperature, timestamp, recorded_by } = req.validatedBody;
  const record = await recordTemperature(box_no, temperature, timestamp, recorded_by);
  res.status(201).json({
    success: true,
    data: record,
    message: '温度记录已上报'
  });
}));

router.get('/audit-logs', asyncHandler(async (req, res) => {
  const logs = await getAuditLogs(req.query);
  res.json({
    success: true,
    data: logs
  });
}));

router.get('/exceptions', asyncHandler(async (req, res) => {
  const exceptions = await getExceptionList();
  res.json({
    success: true,
    data: exceptions
  });
}));

router.post('/export/handover/:box_no', validate('exportRequest'), asyncHandler(async (req, res) => {
  const doc = await exportHandoverDocument(req.params.box_no, req.validatedBody.operator);
  res.json({
    success: true,
    data: doc,
    message: '交接单导出成功'
  });
}));

router.post('/export/exceptions', validate('exportRequest'), asyncHandler(async (req, res) => {
  const doc = await exportExceptionList(req.validatedBody.operator);
  res.json({
    success: true,
    data: doc,
    message: '异常清单导出成功'
  });
}));

router.get('/export/:doc_no', asyncHandler(async (req, res) => {
  const doc = await getExportedDocument(req.params.doc_no);
  if (!doc) {
    return res.status(404).json({
      success: false,
      error: `单据号 ${req.params.doc_no} 不存在`
    });
  }
  res.json({
    success: true,
    data: doc
  });
}));

router.get('/export-history', asyncHandler(async (req, res) => {
  const history = await getExportHistory(req.query.box_no);
  res.json({
    success: true,
    data: history
  });
}));

router.post('/export/:doc_no/reexport', validate('reexportRequest'), asyncHandler(async (req, res) => {
  const result = await reexportDocument(
    req.params.doc_no,
    req.validatedBody.operator,
    req.validatedBody.operator_type,
    req.validatedBody.reexport_reason
  );
  res.json({
    success: true,
    data: result,
    message: `重新导出成功，新单据号: ${result.new_doc_no}`
  });
}));

router.get('/meta/statuses', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(STATUS_FLOW).map(([code, info]) => ({
      code,
      label: info.label,
      allowed_next: info.next
    }))
  });
});

router.get('/meta/custodian-types', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(CUSTODIAN_TYPES).map(([code, label]) => ({ code, label }))
  });
});

router.get('/meta/correction-statuses', (req, res) => {
  res.json({
    success: true,
    data: Object.entries(CORRECTION_STATUS).map(([code, info]) => ({
      code,
      label: info.label,
      can_review: info.can_review
    }))
  });
});

router.post('/corrections', validate('correctionSubmit'), asyncHandler(async (req, res) => {
  const correction = await submitCorrection(req.validatedBody);
  res.status(201).json({
    success: true,
    data: correction,
    message: correction.conflict_warning ? '更正申请已提交，存在冲突风险' : '更正申请已提交'
  });
}));

router.get('/corrections', asyncHandler(async (req, res) => {
  const corrections = await getCorrectionList(req.query);
  res.json({
    success: true,
    data: corrections
  });
}));

router.get('/corrections/:id', asyncHandler(async (req, res) => {
  let correction;
  if (req.params.id.startsWith('GZ')) {
    correction = await getCorrectionByNo(req.params.id);
  } else {
    correction = await getCorrectionDetail(parseInt(req.params.id));
  }
  if (!correction) {
    return res.status(404).json({
      success: false,
      error: `更正申请 ${req.params.id} 不存在`
    });
  }
  res.json({
    success: true,
    data: correction
  });
}));

router.put('/corrections/:id/review', validate('correctionReview'), asyncHandler(async (req, res) => {
  const correctionId = parseInt(req.params.id);
  const correction = await reviewCorrection(correctionId, req.validatedBody);
  res.json({
    success: true,
    data: correction,
    message: correction.has_active_conflicts ? '审核完成，该批次仍有其他待审更正' : `更正申请已${correction.status_label}`
  });
}));

router.get('/corrections/batch/:batch_no/status', asyncHandler(async (req, res) => {
  const status = await getBatchCorrectionStatus(req.params.batch_no);
  res.json({
    success: true,
    data: status
  });
}));

module.exports = router;
