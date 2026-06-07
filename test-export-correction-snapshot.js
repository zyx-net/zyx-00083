const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

function logPass(msg) {
  console.log(`✓ PASS: ${msg}`);
}

function logFail(msg, error) {
  console.log(`✗ FAIL: ${msg}`);
  if (error) {
    console.log(`  错误: ${error.message || error}`);
    if (error.response && error.response.data) {
      console.log(`  响应: ${JSON.stringify(error.response.data)}`);
    }
  }
  process.exitCode = 1;
}

async function runTests() {
  console.log('========================================');
  console.log('  导出更正追溯能力 - 回归测试');
  console.log('========================================\n');

  const BOX_NO = 'BOX-EXPORT-REGRESS-' + Date.now();
  const BATCH_NO = 'BATCH-EXPORT-REGRESS-' + Date.now();
  let tempRecordId = null;
  let correctionId = null;
  let handoverDocNo = null;
  let exceptionDocNo = null;
  let originalSnapshotTime = null;
  let newDocNo = null;

  try {
    console.log('--- 场景1: 健康检查 ---');
    const health = await axios.get(`${BASE_URL}/health`);
    if (health.data.success && health.data.data.status === 'running') {
      logPass('服务运行正常');
    } else {
      logFail('服务健康检查失败');
    }

    console.log('\n--- 场景2: 初始化测试数据 ---');
    await axios.post(`${BASE_URL}/boxes`, {
      box_no: BOX_NO,
      batch_no: BATCH_NO,
      kitchen_staff: '李厨师',
      meal_items: [{ name: '红烧肉套餐', quantity: 2, price: 35 }]
    });

    const statusFlow = [
      { status: 'MEAL_PREPARED', operator: '李厨师', operator_type: 'KITCHEN' },
      { status: 'BOXED', operator: '李厨师', operator_type: 'KITCHEN' },
      {
        status: 'DRIVER_RECEIVED',
        operator: '李厨师',
        operator_type: 'KITCHEN',
        new_custodian: '王司机',
        new_custodian_type: 'DRIVER',
        temperature: 4.5
      }
    ];

    for (const step of statusFlow) {
      await axios.put(`${BASE_URL}/boxes/${BOX_NO}/status/${step.status}`, step);
    }

    const tempResp = await axios.post(`${BASE_URL}/temperature`, {
      box_no: BOX_NO,
      temperature: 15.0,
      timestamp: '2026-06-07 13:00:00',
      recorded_by: '王司机'
    });
    tempRecordId = tempResp.data.data.id;
    logPass(`测试数据初始化完成，温度记录ID: ${tempRecordId}`);

    console.log('\n--- 场景3: 普通导出交接单，验证包含更正快照 ---');
    const handoverResp = await axios.post(`${BASE_URL}/export/handover/${BOX_NO}`, {
      operator: '王店长'
    });
    handoverDocNo = handoverResp.data.data.doc_no;

    if (!handoverResp.data.data.correction_snapshot) {
      throw new Error('交接单未包含correction_snapshot字段');
    }

    const handoverSnapshot = handoverResp.data.data.correction_snapshot;
    if (!handoverSnapshot.snapshot_time || !handoverSnapshot.overall) {
      throw new Error('更正快照格式不正确');
    }
    if (!handoverSnapshot.batch_summaries[BATCH_NO]) {
      throw new Error('更正快照未包含批次信息');
    }

    originalSnapshotTime = handoverSnapshot.snapshot_time;
    logPass(`交接单导出成功，单据号: ${handoverDocNo}，快照时间: ${originalSnapshotTime}`);

    console.log('\n--- 场景4: 普通导出异常清单，验证包含更正快照 ---');
    const exceptionResp = await axios.post(`${BASE_URL}/export/exceptions`, {
      operator: '赵质控'
    });
    exceptionDocNo = exceptionResp.data.data.doc_no;

    if (!exceptionResp.data.data.correction_snapshot) {
      throw new Error('异常清单未包含correction_snapshot字段');
    }

    logPass(`异常清单导出成功，单据号: ${exceptionDocNo}`);

    console.log('\n--- 场景5: 提交更正申请 ---');
    const corrResp = await axios.post(`${BASE_URL}/corrections`, {
      box_no: BOX_NO,
      record_type: 'temperature',
      record_id: tempRecordId,
      field_name: 'temperature',
      proposed_value: '4.8',
      apply_reason: '温度单位误操作',
      applicant: '王司机',
      applicant_type: 'DRIVER'
    });
    correctionId = corrResp.data.data.id;
    logPass(`更正申请提交成功，ID: ${correctionId}`);

    console.log('\n--- 场景6: 验证历史单据快照未被悄悄改写 ---');
    const docCheck = await axios.get(`${BASE_URL}/export/${handoverDocNo}`);
    const checkSnapshot = docCheck.data.data.correction_snapshot;

    if (checkSnapshot.snapshot_time !== originalSnapshotTime) {
      throw new Error(`快照时间被修改！原: ${originalSnapshotTime}, 现: ${checkSnapshot.snapshot_time}`);
    }

    if (checkSnapshot.overall.total_corrections !== 0) {
      throw new Error(`快照被改写！原更正总数应为0，现为: ${checkSnapshot.overall.total_corrections}`);
    }

    logPass('历史单据快照保持不变，未被后续更正申请改写');

    console.log('\n--- 场景7: QC审核更正申请 ---');
    await axios.put(`${BASE_URL}/corrections/${correctionId}/review`, {
      reviewer: '赵质控',
      reviewer_type: 'QC',
      review_result: 'APPROVED',
      review_reason: '经核实，温度记录确实有误'
    });
    logPass('更正申请审核通过');

    console.log('\n--- 场景8: 再次验证历史单据快照未变 ---');
    const docCheck2 = await axios.get(`${BASE_URL}/export/${handoverDocNo}`);
    const checkSnapshot2 = docCheck2.data.data.correction_snapshot;

    if (checkSnapshot2.overall.approved_count !== 0) {
      throw new Error(`快照被改写！已通过数量应为0，现为: ${checkSnapshot2.overall.approved_count}`);
    }

    if (checkSnapshot2.overall.pending_count !== 0) {
      throw new Error(`快照被改写！待审核数量应为0，现为: ${checkSnapshot2.overall.pending_count}`);
    }

    logPass('审核后历史快照仍保持不变，符合预期');

    console.log('\n--- 场景9: 非QC角色重新导出被拒 ---');
    try {
      await axios.post(`${BASE_URL}/export/${handoverDocNo}/reexport`, {
        operator: '王司机',
        operator_type: 'DRIVER',
        reexport_reason: '测试非QC权限'
      });
      logFail('非QC角色应该被拒绝，但请求成功了');
    } catch (error) {
      if (error.response && error.response.status === 403 &&
          error.response.data.error.includes('QC')) {
        logPass('非QC角色重新导出被正确拒绝，返回403');
      } else {
        throw error;
      }
    }

    console.log('\n--- 场景10: QC重新导出成功 ---');
    const reexportResp = await axios.post(`${BASE_URL}/export/${handoverDocNo}/reexport`, {
      operator: '赵质控',
      operator_type: 'QC',
      reexport_reason: '更正已审核通过，更新单据快照'
    });

    newDocNo = reexportResp.data.data.new_doc_no;
    if (!newDocNo || newDocNo === handoverDocNo) {
      throw new Error('重新导出未生成新单据号');
    }

    if (reexportResp.data.data.version !== 2) {
      throw new Error(`版本号应为2，现为: ${reexportResp.data.data.version}`);
    }

    if (!reexportResp.data.data.correction_summary) {
      throw new Error('缺少更正摘要信息');
    }

    logPass(`重新导出成功，新单据号: ${newDocNo}，版本: 2`);

    console.log('\n--- 场景11: 验证新单据快照已更新 ---');
    const newDocResp = await axios.get(`${BASE_URL}/export/${newDocNo}`);
    const newSnapshot = newDocResp.data.data.correction_snapshot;

    if (newSnapshot.overall.total_corrections !== 1) {
      throw new Error(`新快照更正总数应为1，现为: ${newSnapshot.overall.total_corrections}`);
    }

    if (newSnapshot.overall.approved_count !== 1) {
      throw new Error(`新快照已通过数量应为1，现为: ${newSnapshot.overall.approved_count}`);
    }

    if (newSnapshot.overall.pending_count !== 0) {
      throw new Error(`新快照待审核数量应为0，现为: ${newSnapshot.overall.pending_count}`);
    }

    const batchSummary = newSnapshot.batch_summaries[BATCH_NO];
    if (!batchSummary.latest_reviewer || batchSummary.latest_reviewer !== '赵质控') {
      throw new Error('新快照未包含最近审核人信息');
    }

    if (!batchSummary.latest_review_reason) {
      throw new Error('新快照未包含最近审核原因');
    }

    logPass('新单据快照已正确更新，包含审核状态和审核人信息');

    console.log('\n--- 场景12: 验证审计日志 ---');
    const auditResp = await axios.get(`${BASE_URL}/audit-logs?action=DOCUMENT_REEXPORT`);
    const reexportLogs = auditResp.data.data.filter(
      log => log.details && (JSON.parse(log.details).new_doc_no === newDocNo)
    );

    if (reexportLogs.length === 0) {
      throw new Error('未找到重新导出的审计日志');
    }

    const logDetails = JSON.parse(reexportLogs[0].details);
    if (!logDetails.old_doc_no || !logDetails.new_doc_no ||
        !logDetails.reexport_reason || !logDetails.correction_summary) {
      throw new Error('审计日志缺少必要字段');
    }

    logPass('审计日志记录完整，包含新旧单据号、原因和更正摘要');

    console.log('\n--- 场景13: 验证导出历史接口返回快照 ---');
    const historyResp = await axios.get(`${BASE_URL}/export-history?box_no=${BOX_NO}`);
    const hasSnapshot = historyResp.data.data.every(d => d.correction_snapshot !== null);

    if (!hasSnapshot) {
      throw new Error('导出历史中存在单据缺少更正快照');
    }

    logPass('导出历史接口正确返回所有单据的更正快照');

    console.log('\n--- 场景14: 关闭重新导出开关，验证功能被禁用 ---');
    const timestamp = Date.now();
    await axios.post(`${BASE_URL}/config`, {
      operator: '系统管理员',
      version: `v1.0.0-reexport-off-${timestamp}`,
      temp_min: 0,
      temp_max: 8,
      delivery_time_limit: 120,
      correction_review_time_limit: 24,
      allow_reexport: false,
      acceptance_rules: {
        require_temperature_check: true,
        require_timestamp: true,
        max_acceptable_temp_deviation: 2,
        require_custodian_verification: true,
        allow_partial_acceptance: false
      }
    });

    try {
      await axios.post(`${BASE_URL}/export/${handoverDocNo}/reexport`, {
        operator: '赵质控',
        operator_type: 'QC',
        reexport_reason: '测试配置关闭'
      });
      logFail('配置关闭时应该被拒绝，但请求成功了');
    } catch (error) {
      if (error.response && error.response.status === 403 &&
          error.response.data.error.includes('关闭')) {
        logPass('配置关闭时重新导出被正确拒绝');
      } else {
        throw error;
      }
    }

    console.log('\n--- 场景15: 恢复默认配置 ---');
    await axios.post(`${BASE_URL}/config`, {
      operator: '系统管理员',
      version: `v1.0.0-reexport-on-${timestamp}`,
      temp_min: 0,
      temp_max: 8,
      delivery_time_limit: 120,
      correction_review_time_limit: 24,
      allow_reexport: true,
      acceptance_rules: {
        require_temperature_check: true,
        require_timestamp: true,
        max_acceptable_temp_deviation: 2,
        require_custodian_verification: true,
        allow_partial_acceptance: false
      }
    });
    logPass('已恢复默认配置（allow_reexport=true）');

    console.log('\n--- 场景16: 重新导出必须提供原因 ---');
    try {
      await axios.post(`${BASE_URL}/export/${handoverDocNo}/reexport`, {
        operator: '赵质控',
        operator_type: 'QC'
      });
      logFail('缺少原因应该被拒绝，但请求成功了');
    } catch (error) {
      if (error.response && error.response.status === 400) {
        logPass('缺少重新导出原因时被正确拒绝，返回400');
      } else {
        throw error;
      }
    }

    console.log('\n--- 场景17: 验证服务重启后快照不变（模拟） ---');
    const beforeRestartSnapshot = await axios.get(`${BASE_URL}/export/${handoverDocNo}`);
    const beforeSnapshot = beforeRestartSnapshot.data.data.correction_snapshot;

    console.log('  (提示: 请手动重启服务后运行 test-export-restart-verify.js 验证)');
    console.log(`  原始单据号: ${handoverDocNo}`);
    console.log(`  快照时间: ${beforeSnapshot.snapshot_time}`);
    console.log(`  更正总数: ${beforeSnapshot.overall.total_corrections}`);

    logPass('快照数据已准备好用于重启验证');

    console.log('\n--- 场景18: 验证打印格式包含快照信息 ---');
    if (!handoverResp.data.data.printable_format.includes('更正快照')) {
      throw new Error('交接单打印格式未包含更正快照信息');
    }
    logPass('打印格式正确包含更正快照摘要');

    console.log('\n========================================');
    if (process.exitCode !== 1) {
      console.log('  ✓ 所有测试场景通过！');
    } else {
      console.log('  ✗ 部分测试失败，请检查上面的输出');
    }
    console.log('========================================');

    console.log('\n测试数据参考（用于重启后验证）:');
    console.log(`  测试箱号: ${BOX_NO}`);
    console.log(`  测试批次: ${BATCH_NO}`);
    console.log(`  原始交接单: ${handoverDocNo}`);
    console.log(`  重新导出交接单: ${newDocNo}`);
    console.log(`  异常清单: ${exceptionDocNo}`);

  } catch (error) {
    logFail('测试执行异常', error);
  }
}

runTests();
