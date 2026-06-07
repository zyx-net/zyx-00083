const axios = require('axios');
const moment = require('moment');
const { run, get, all } = require('./src/database/init');

const baseUrl = 'http://localhost:3000';
const testId = Date.now();
const boxNo1 = `BOX-EXP-REG-${testId}-1`;
const boxNo2 = `BOX-EXP-REG-${testId}-2`;
const boxNo3 = `BOX-EXP-REG-${testId}-3`;
const batchNo = `BATCH-EXP-REG-${testId}`;

let passCount = 0;
let failCount = 0;

async function invokeApi(path, method = 'GET', body = null) {
  const url = `${baseUrl}${path}`;
  try {
    const axiosConfig = { url, method, validateStatus: () => true };
    if (body) {
      axiosConfig.data = body;
      axiosConfig.headers = { 'Content-Type': 'application/json' };
    }
    const response = await axios(axiosConfig);
    return {
      ...response.data,
      status: response.status,
      is_success: response.data.success === true,
      is_error: response.data.success === false
    };
  } catch (error) {
    return {
      error: error.message,
      status: error.response ? error.response.status : 0,
      is_success: false,
      is_error: true
    };
  }
}

function test(testName, result, expectedSuccess, expectedStatusCode = null, extraCheck = null) {
  const success = (result.is_success === expectedSuccess) && 
                  (expectedStatusCode ? result.status === expectedStatusCode : true) &&
                  (extraCheck ? extraCheck(result) : true);
  if (success) {
    passCount++;
    console.log(`✓ PASS  ${testName}`);
    console.log(`         Status: ${result.status}, success: ${result.is_success}`);
  } else {
    failCount++;
    console.log(`✗ FAIL  ${testName}`);
    console.log(`         Expected: success=${expectedSuccess}, status=${expectedStatusCode || 'any'}`);
    console.log(`         Actual:   success=${result.is_success}, status=${result.status}`);
    if (result.error) console.log(`         Error: ${result.error}`);
    if (result.data) console.log(`         Data: ${JSON.stringify(result.data, null, 2).substring(0, 500)}`);
  }
  return success;
}

async function setupTestData() {
  console.log('\n=== 准备测试数据 ===\n');

  for (const boxNo of [boxNo1, boxNo2, boxNo3]) {
    await invokeApi('/api/boxes', 'POST', {
      box_no: boxNo,
      batch_no: batchNo,
      kitchen_staff: '李厨师',
      meal_items: [{ name: '测试套餐', quantity: 1, price: 25 }]
    });

    await invokeApi(`/api/boxes/${boxNo}/status/MEAL_PREPARED`, 'PUT', {
      operator: '李厨师', operator_type: 'KITCHEN'
    });

    await invokeApi(`/api/boxes/${boxNo}/status/BOXED`, 'PUT', {
      operator: '李厨师', operator_type: 'KITCHEN'
    });

    await invokeApi(`/api/boxes/${boxNo}/status/DRIVER_RECEIVED`, 'PUT', {
      operator: '李厨师', operator_type: 'KITCHEN',
      new_custodian: '王司机', new_custodian_type: 'DRIVER',
      temperature: 4.5
    });

    await invokeApi('/api/temperature', 'POST', {
      box_no: boxNo, temperature: 15.0,
      timestamp: '2026-06-07 13:00:00', recorded_by: '王司机'
    });
  }

  const boxDetail = await invokeApi(`/api/boxes/${boxNo1}`, 'GET');
  return {
    tempRecordId: boxDetail.data.temperature_readings[0].id,
    statusRecordId: boxDetail.data.status_history[3].id
  };
}

async function test1_ConfigModification() {
  console.log('\n' + '='.repeat(70));
  console.log('  测试1: 配置修改 - 更改审核时限');
  console.log('='.repeat(70));

  const originalConfig = await invokeApi('/api/config', 'GET');
  const originalLimit = originalConfig.data.correction_review_time_limit;
  console.log(`\n  原始审核时限: ${originalLimit}小时`);

  const newVersion = `v1.0.0-TEST-${testId}`;
  const updateResult = await invokeApi('/api/config', 'POST', {
    operator: '测试管理员',
    version: newVersion,
    temp_min: 0,
    temp_max: 8,
    delivery_time_limit: 120,
    correction_review_time_limit: 1,
    acceptance_rules: {
      require_temperature_check: true,
      require_timestamp: true,
      max_acceptable_temp_deviation: 2,
      require_custodian_verification: true,
      allow_partial_acceptance: false
    },
    correctable_fields_whitelist: ['current_custodian', 'temperature', 'timestamp', 'operator', 'custodian_type']
  });

  test('配置更新成功', updateResult, true, 200);

  const newConfig = await invokeApi('/api/config', 'GET');
  test('新配置生效', newConfig, true, 200, 
    r => r.data.correction_review_time_limit === 1);
  console.log(`  新审核时限: ${newConfig.data.correction_review_time_limit}小时`);

  return { originalLimit, newVersion };
}

async function test2_SubmitCorrections(recordIds) {
  console.log('\n' + '='.repeat(70));
  console.log('  测试2: 提交多条更正申请 - 验证冲突检测');
  console.log('='.repeat(70));

  const corrections = [];

  console.log('\n  提交第1条更正（箱1，温度）:');
  const corr1 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo1,
    record_type: 'temperature',
    record_id: recordIds.tempRecordId,
    field_name: 'temperature',
    proposed_value: '4.8',
    apply_reason: '测试过期1',
    applicant: '王司机',
    applicant_type: 'DRIVER'
  });
  test('第1条更正提交成功（无冲突）', corr1, true, 201, 
    r => r.data.conflict_warning === 0);
  corrections.push({ id: corr1.data.id, correction_no: corr1.data.correction_no });

  console.log('\n  提交第2条更正（箱1，操作人）:');
  const corr2 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo1,
    record_type: 'status_history',
    record_id: recordIds.statusRecordId,
    field_name: 'operator',
    proposed_value: '张司机',
    apply_reason: '测试过期2',
    applicant: '李店长',
    applicant_type: 'STORE'
  });
  test('第2条更正提交成功（检测到冲突）', corr2, true, 201,
    r => r.data.conflict_warning === 1 && r.data.has_active_conflicts === true);
  corrections.push({ id: corr2.data.id, correction_no: corr2.data.correction_no });

  console.log('\n  提交第3条更正（箱2，温度）:');
  const corr3 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo2,
    record_type: 'temperature',
    record_id: recordIds.tempRecordId,
    field_name: 'temperature',
    proposed_value: '5.0',
    apply_reason: '测试过期3',
    applicant: '王司机',
    applicant_type: 'DRIVER'
  });
  test('第3条更正提交成功（同批次，冲突）', corr3, true, 201,
    r => r.data.conflict_warning === 1);
  corrections.push({ id: corr3.data.id, correction_no: corr3.data.correction_no });

  console.log('\n  验证批次状态:');
  const batchStatus = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  test('批次状态显示3条待审，有冲突', batchStatus, true, 200,
    r => r.data.pending_count === 3 && r.data.has_conflicts === true);
  console.log(`  pending_count: ${batchStatus.data.pending_count}, has_conflicts: ${batchStatus.data.has_conflicts}`);

  return corrections;
}

async function test3_ManipulateExpiration(corrections) {
  console.log('\n' + '='.repeat(70));
  console.log('  测试3: 模拟过期 - 直接修改数据库expires_at');
  console.log('='.repeat(70));

  const pastTime = moment().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss');
  console.log(`\n  将第1条更正的expires_at设为过去时间: ${pastTime}`);

  await run(
    'UPDATE correction_applications SET expires_at = ? WHERE id = ?',
    [pastTime, corrections[0].id]
  );

  const verify = await get(
    'SELECT id, status, expires_at FROM correction_applications WHERE id = ?',
    [corrections[0].id]
  );
  console.log(`  数据库中 expires_at: ${verify.expires_at}, status: ${verify.status}`);

  return corrections[0].id;
}

async function test4_QueryDetailAutoExpire(expiredId) {
  console.log('\n' + '='.repeat(70));
  console.log('  测试4: 查询详情时自动检测并标记过期');
  console.log('='.repeat(70));

  console.log('\n  查询已过期的更正详情:');
  const detail = await invokeApi(`/api/corrections/${expiredId}`, 'GET');
  test('查询详情成功，状态已自动变为已过期', detail, true, 200,
    r => r.data.status === 'EXPIRED' && r.data.status_label === '已过期');
  console.log(`  status: ${detail.data.status}, status_label: ${detail.data.status_label}`);
  console.log(`  expires_at: ${detail.data.expires_at}`);

  console.log('\n  再次查询详情（验证不会重复处理）:');
  const detail2 = await invokeApi(`/api/corrections/${expiredId}`, 'GET');
  test('再次查询状态仍为已过期', detail2, true, 200,
    r => r.data.status === 'EXPIRED');

  console.log('\n  验证审计日志（仅1条过期记录）:');
  const logs = await invokeApi(`/api/audit-logs?action=CORRECTION_EXPIRED`, 'GET');
  const expiredLogs = logs.data.filter(l => 
    l.details && l.details.includes(`"correction_id":${expiredId}`)
  );
  test('过期审计日志仅1条（避免重复刷日志）', logs, true, 200,
    r => expiredLogs.length === 1);
  console.log(`  CORRECTION_EXPIRED 日志数: ${expiredLogs.length}`);
  if (expiredLogs.length > 0) {
    console.log(`  操作者: ${expiredLogs[0].operator}, 时间: ${expiredLogs[0].timestamp}`);
    console.log(`  详情: ${expiredLogs[0].details.substring(0, 200)}`);
  }
}

async function test5_BatchStatusAfterExpiration() {
  console.log('\n' + '='.repeat(70));
  console.log('  测试5: 批次状态 - 过期后重算冲突');
  console.log('='.repeat(70));

  const batchStatus = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  test('批次状态: pending_count=2, expired_count=1, has_conflicts=true', 
    batchStatus, true, 200,
    r => r.data.pending_count === 2 && 
         r.data.expired_count === 1 && 
         r.data.has_conflicts === true);
  console.log(`  pending_count: ${batchStatus.data.pending_count}`);
  console.log(`  expired_count: ${batchStatus.data.expired_count}`);
  console.log(`  has_conflicts: ${batchStatus.data.has_conflicts}`);
  console.log(`  approved_count: ${batchStatus.data.approved_count}`);
  console.log(`  rejected_count: ${batchStatus.data.rejected_count}`);

  const pendingCorrections = batchStatus.data.all_corrections.filter(c => c.status === 'PENDING');
  const allHaveWarning = pendingCorrections.every(c => c.conflict_warning === 1);
  test('剩余待审更正的冲突标记已重算', batchStatus, true, 200,
    () => allHaveWarning);
  console.log(`  剩余待审数: ${pendingCorrections.length}, 均标记冲突: ${allHaveWarning}`);
}

async function test6_ReviewExpiredCorrection(expiredId) {
  console.log('\n' + '='.repeat(70));
  console.log('  测试6: 尝试审核已过期的申请 - 应被拒绝');
  console.log('='.repeat(70));

  console.log('\n  尝试通过已过期的申请:');
  const approveResult = await invokeApi(`/api/corrections/${expiredId}/review`, 'PUT', {
    reviewer: '赵质控',
    reviewer_type: 'QC',
    review_result: 'APPROVED',
    review_reason: '尝试通过过期申请'
  });
  test('审核已过期申请被拒绝（400错误）', approveResult, false, 400,
    r => r.error && r.error.includes('已超过审核时限'));
  console.log(`  错误信息: ${approveResult.error}`);

  console.log('\n  尝试驳回已过期的申请:');
  const rejectResult = await invokeApi(`/api/corrections/${expiredId}/review`, 'PUT', {
    reviewer: '赵质控',
    reviewer_type: 'QC',
    review_result: 'REJECTED',
    review_reason: '尝试驳回过期申请'
  });
  test('驳回已过期申请被拒绝（400错误）', rejectResult, false, 400,
    r => r.error && r.error.includes('已超过审核时限'));
  console.log(`  错误信息: ${rejectResult.error}`);

  const verify = await invokeApi(`/api/corrections/${expiredId}`, 'GET');
  test('状态仍为已过期', verify, true, 200,
    r => r.data.status === 'EXPIRED');
}

async function test7_ExportWithExpiredStatus() {
  console.log('\n' + '='.repeat(70));
  console.log('  测试7: 异常清单导出 - 显示已过期状态');
  console.log('='.repeat(70));

  await invokeApi(`/api/boxes/${boxNo1}/status/EXCEPTION_ISOLATED`, 'PUT', {
    operator: '王司机', operator_type: 'DRIVER',
    new_custodian: '赵质控', new_custodian_type: 'QC',
    exception_reason: '温度超标'
  });

  await invokeApi(`/api/boxes/${boxNo2}/status/EXCEPTION_ISOLATED`, 'PUT', {
    operator: '王司机', operator_type: 'DRIVER',
    new_custodian: '赵质控', new_custodian_type: 'QC',
    exception_reason: '温度超标'
  });

  console.log('\n  导出异常清单:');
  const exportResult = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  });
  test('导出成功', exportResult, true, 200);

  const box1Export = exportResult.data.exceptions.find(e => e.box_no === boxNo1);
  const box2Export = exportResult.data.exceptions.find(e => e.box_no === boxNo2);

  test('box1的correction_status显示已过期', exportResult, true, 200,
    () => box1Export && box1Export.correction_status.expired_count === 1);
  console.log(`  box1 - pending: ${box1Export?.correction_status?.pending_count}, expired: ${box1Export?.correction_status?.expired_count}`);

  test('box2的correction_status显示待审', exportResult, true, 200,
    () => box2Export && box2Export.correction_status.pending_count === 1);
  console.log(`  box2 - pending: ${box2Export?.correction_status?.pending_count}, expired: ${box2Export?.correction_status?.expired_count}`);

  console.log('\n  验证打印格式包含过期状态:');
  const printable = exportResult.data.printable_format;
  const hasExpiredText = printable.includes('已过期');
  test('打印格式包含"已过期"文字', exportResult, true, 200,
    () => hasExpiredText);
  console.log(`  打印格式包含已过期文字: ${hasExpiredText}`);

  if (box1Export?.correction_status?.latest_correction) {
    const latest = box1Export.correction_status.latest_correction;
    console.log(`  最新更正状态: ${latest.status_label} (${latest.status})`);
    console.log(`  过期时间: ${latest.expires_at}`);
  }
}

async function test8_ExpireAnother(corrections) {
  console.log('\n' + '='.repeat(70));
  console.log('  测试8: 第2条过期后 - 冲突重算（仅剩1条待审应无冲突）');
  console.log('='.repeat(70));

  const pastTime = moment().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss');
  await run(
    'UPDATE correction_applications SET expires_at = ? WHERE id = ?',
    [pastTime, corrections[1].id]
  );

  const batchStatus = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  test('批次状态: pending_count=1, expired_count=2, has_conflicts=false',
    batchStatus, true, 200,
    r => r.data.pending_count === 1 &&
         r.data.expired_count === 2 &&
         r.data.has_conflicts === false);
  console.log(`  pending_count: ${batchStatus.data.pending_count}`);
  console.log(`  expired_count: ${batchStatus.data.expired_count}`);
  console.log(`  has_conflicts: ${batchStatus.data.has_conflicts}`);

  const pendingCorrection = batchStatus.data.all_corrections.find(c => c.status === 'PENDING');
  test('仅剩的待审更正冲突标记已清除', batchStatus, true, 200,
    () => pendingCorrection && pendingCorrection.conflict_warning === 0);
  console.log(`  仅剩待审的 conflict_warning: ${pendingCorrection?.conflict_warning}`);
}

async function test9_VerifyAuditLogs(corrections) {
  console.log('\n' + '='.repeat(70));
  console.log('  测试9: 审计日志 - 验证触发时间和操作者');
  console.log('='.repeat(70));

  const logs = await invokeApi(`/api/audit-logs?action=CORRECTION_EXPIRED`, 'GET');
  const expiredLogs = logs.data.filter(l =>
    l.details && (
      l.details.includes(`"correction_id":${corrections[0].id}`) ||
      l.details.includes(`"correction_id":${corrections[1].id}`)
    )
  );

  test('过期审计日志共2条（每条过期各1条）', logs, true, 200,
    r => expiredLogs.length === 2);
  console.log(`  过期日志总数: ${expiredLogs.length}`);

  for (const log of expiredLogs) {
    const details = JSON.parse(log.details);
    test(`日志${log.id}: 操作者为SYSTEM`, logs, true, 200,
      () => log.operator === 'SYSTEM');
    test(`日志${log.id}: 包含触发时间`, logs, true, 200,
      () => details.expired_at && details.submitted_at && details.expires_at);
    console.log(`  - 更正ID: ${details.correction_id}, 编号: ${details.correction_no}`);
    console.log(`    操作者: ${log.operator}, 触发时间: ${details.expired_at}`);
    console.log(`    提交时间: ${details.submitted_at}, 到期时间: ${details.expires_at}`);
  }

  console.log('\n  验证无重复日志:');
  const detail = await invokeApi(`/api/corrections/${corrections[0].id}`, 'GET');
  const logsAfter = await invokeApi(`/api/audit-logs?action=CORRECTION_EXPIRED`, 'GET');
  const expiredLogsAfter = logsAfter.data.filter(l =>
    l.details && l.details.includes(`"correction_id":${corrections[0].id}`)
  );
  test('再次查询后不会新增重复日志', logsAfter, true, 200,
    r => expiredLogsAfter.length === 1);
  console.log(`  再次查询后日志数: ${expiredLogsAfter.length}（未增加）`);
}

async function test10_ServiceRestartPersistence(corrections, originalLimit, newVersion) {
  console.log('\n' + '='.repeat(70));
  console.log('  测试10: 服务重启后数据一致性');
  console.log('='.repeat(70));

  console.log('\n  === 请重启服务后，验证以下内容 ===');
  console.log('  重启命令: 停止当前服务后运行 npm start');
  console.log('  重启后将自动执行验证...\n');

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  await new Promise(resolve => {
    rl.question('  服务重启完成后，请按回车键继续验证...', () => {
      rl.close();
      resolve();
    });
  });

  console.log('\n  开始验证重启后的数据一致性...\n');

  console.log('  1. 验证配置保持不变:');
  const config = await invokeApi('/api/config', 'GET');
  test('配置版本正确，审核时限为1小时', config, true, 200,
    r => r.data.version === newVersion && r.data.correction_review_time_limit === 1);
  console.log(`    版本: ${config.data.version}, 审核时限: ${config.data.correction_review_time_limit}小时`);

  console.log('\n  2. 验证更正申请状态:');
  const corr0 = await invokeApi(`/api/corrections/${corrections[0].id}`, 'GET');
  test('第1条仍为已过期', corr0, true, 200, r => r.data.status === 'EXPIRED');

  const corr1 = await invokeApi(`/api/corrections/${corrections[1].id}`, 'GET');
  test('第2条仍为已过期', corr1, true, 200, r => r.data.status === 'EXPIRED');

  const corr2 = await invokeApi(`/api/corrections/${corrections[2].id}`, 'GET');
  test('第3条仍为待审核', corr2, true, 200, r => r.data.status === 'PENDING');
  console.log(`    状态: ${corr0.data.status_label}, ${corr1.data.status_label}, ${corr2.data.status_label}`);

  console.log('\n  3. 验证批次状态:');
  const batchStatus = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  test('批次状态正确: pending=1, expired=2, 无冲突', batchStatus, true, 200,
    r => r.data.pending_count === 1 &&
         r.data.expired_count === 2 &&
         r.data.has_conflicts === false);
  console.log(`    pending: ${batchStatus.data.pending_count}, expired: ${batchStatus.data.expired_count}`);
  console.log(`    has_conflicts: ${batchStatus.data.has_conflicts}`);

  console.log('\n  4. 验证审计日志完整:');
  const logs = await invokeApi(`/api/audit-logs?action=CORRECTION_EXPIRED`, 'GET');
  const expiredLogs = logs.data.filter(l =>
    l.details && (
      l.details.includes(`"correction_id":${corrections[0].id}`) ||
      l.details.includes(`"correction_id":${corrections[1].id}`)
    )
  );
  test('过期审计日志仍为2条', logs, true, 200, r => expiredLogs.length === 2);
  console.log(`    过期日志数: ${expiredLogs.length}`);

  console.log('\n  5. 验证expires_at按数据库提交时间稳定生效:');
  const pending = await get(
    'SELECT id, submitted_at, expires_at FROM correction_applications WHERE id = ?',
    [corrections[2].id]
  );
  const submitted = moment(pending.submitted_at);
  const expires = moment(pending.expires_at);
  const diffHours = expires.diff(submitted, 'hours');
  test('expires_at与submitted_at相差1小时（配置的审核时限）', true, true, null,
    () => diffHours === 1);
  console.log(`    submitted_at: ${pending.submitted_at}`);
  console.log(`    expires_at: ${pending.expires_at}`);
  console.log(`    相差: ${diffHours}小时`);

  console.log('\n  6. 验证导出仍显示正确状态:');
  const exportResult = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  });
  const box1Export = exportResult.data.exceptions.find(e => e.box_no === boxNo1);
  test('重启后导出仍显示过期状态', exportResult, true, 200,
    () => box1Export && box1Export.correction_status.expired_count >= 1);
  console.log(`    box1 expired_count: ${box1Export?.correction_status?.expired_count}`);

  console.log('\n  7. 恢复默认配置:');
  const restoreVersion = `v1.0.0-RESTORE-${testId}`;
  const restoreResult = await invokeApi('/api/config', 'POST', {
    operator: '测试管理员',
    version: restoreVersion,
    temp_min: 0,
    temp_max: 8,
    delivery_time_limit: 120,
    correction_review_time_limit: originalLimit,
    acceptance_rules: {
      require_temperature_check: true,
      require_timestamp: true,
      max_acceptable_temp_deviation: 2,
      require_custodian_verification: true,
      allow_partial_acceptance: false
    },
    correctable_fields_whitelist: ['current_custodian', 'temperature', 'timestamp', 'operator', 'custodian_type']
  });
  test('恢复默认配置成功', restoreResult, true, 200);
  console.log(`    审核时限已恢复为: ${originalLimit}小时`);
}

async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('  更正申请过期自动收口 - 回归测试套件');
  console.log('='.repeat(70));
  console.log(`  测试时间: ${new Date().toISOString()}`);
  console.log(`  测试批次: ${batchNo}`);
  console.log('='.repeat(70));

  try {
    const recordIds = await setupTestData();
    const { originalLimit, newVersion } = await test1_ConfigModification();
    const corrections = await test2_SubmitCorrections(recordIds);
    const expiredId = await test3_ManipulateExpiration(corrections);
    await test4_QueryDetailAutoExpire(expiredId);
    await test5_BatchStatusAfterExpiration();
    await test6_ReviewExpiredCorrection(expiredId);
    await test7_ExportWithExpiredStatus();
    await test8_ExpireAnother(corrections);
    await test9_VerifyAuditLogs(corrections);
    await test10_ServiceRestartPersistence(corrections, originalLimit, newVersion);
  } catch (err) {
    console.error('\n  测试执行异常:', err);
    failCount++;
  }

  console.log('\n' + '='.repeat(70));
  console.log('  测试总结');
  console.log('='.repeat(70));
  console.log(`  总测试数: ${passCount + failCount}`);
  console.log(`  通过: ${passCount}`);
  console.log(`  失败: ${failCount}`);
  console.log(`  通过率: ${((passCount / (passCount + failCount)) * 100).toFixed(2)}%`);
  console.log('='.repeat(70) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
