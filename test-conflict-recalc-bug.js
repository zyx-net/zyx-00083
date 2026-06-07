const axios = require('axios');
const moment = require('moment');
const { initDatabase, run, get } = require('./src/database/init');

const baseUrl = 'http://localhost:3000';
const testId = Date.now();
const boxNo = `BOX-CONFLICT-BUG-${testId}`;
const batchNo = `BATCH-CONFLICT-BUG-${testId}`;

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
  } else {
    failCount++;
    console.log(`✗ FAIL  ${testName}`);
    console.log(`         Expected: success=${expectedSuccess}, status=${expectedStatusCode || 'any'}`);
    console.log(`         Actual:   success=${result.is_success}, status=${result.status}`);
    if (result.error) console.log(`         Error: ${result.error}`);
    if (result.data) console.log(`         Data: ${JSON.stringify(result.data, null, 2).substring(0, 800)}`);
  }
  return success;
}

async function runTests() {
  await initDatabase();
  
  console.log('\n' + '='.repeat(70));
  console.log('  冲突重算 Bug 复现与验证测试');
  console.log('='.repeat(70));
  console.log(`  测试批次: ${batchNo}`);
  console.log(`  测试时间: ${new Date().toISOString()}`);
  console.log('='.repeat(70));

  console.log('\n=== 步骤1: 准备测试数据 ===\n');

  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo,
    batch_no: batchNo,
    kitchen_staff: '李厨师',
    meal_items: [{ name: '测试套餐', quantity: 1, price: 25 }]
  });

  for (const status of ['MEAL_PREPARED', 'BOXED', 'DRIVER_RECEIVED']) {
    await invokeApi(`/api/boxes/${boxNo}/status/${status}`, 'PUT', {
      operator: '李厨师',
      operator_type: 'KITCHEN',
      new_custodian: status === 'DRIVER_RECEIVED' ? '王司机' : undefined,
      new_custodian_type: status === 'DRIVER_RECEIVED' ? 'DRIVER' : undefined,
      temperature: status === 'DRIVER_RECEIVED' ? 4.5 : undefined
    });
  }

  const tempRecord = await invokeApi('/api/temperature', 'POST', {
    box_no: boxNo,
    temperature: 15.0,
    timestamp: '2026-06-07 13:00:00',
    recorded_by: '王司机'
  });
  const tempRecordId = tempRecord.data.id;

  const boxDetail = await invokeApi(`/api/boxes/${boxNo}`, 'GET');
  const statusRecordId = boxDetail.data.status_history[3].id;

  console.log('\n=== 步骤2: 提交2条更正申请（同批次，应产生冲突） ===\n');

  const corr1 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo,
    record_type: 'temperature',
    record_id: tempRecordId,
    field_name: 'temperature',
    proposed_value: '4.8',
    apply_reason: '测试冲突1',
    applicant: '王司机',
    applicant_type: 'DRIVER'
  });
  test('第1条提交成功，无冲突警告', corr1, true, 201,
    r => r.data.conflict_warning === 0);
  console.log(`  更正1: id=${corr1.data.id}, conflict_warning=${corr1.data.conflict_warning}`);

  const corr2 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo,
    record_type: 'status_history',
    record_id: statusRecordId,
    field_name: 'operator',
    proposed_value: '张司机',
    apply_reason: '测试冲突2',
    applicant: '李店长',
    applicant_type: 'STORE'
  });
  test('第2条提交成功，检测到冲突警告', corr2, true, 201,
    r => r.data.conflict_warning === 1 && r.data.has_active_conflicts === true);
  console.log(`  更正2: id=${corr2.data.id}, conflict_warning=${corr2.data.conflict_warning}, has_active_conflicts=${corr2.data.has_active_conflicts}`);

  const batchStatus1 = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  test('批次状态: pending=2, has_conflicts=true', batchStatus1, true, 200,
    r => r.data.pending_count === 2 && r.data.has_conflicts === true);
  console.log(`  批次: pending_count=${batchStatus1.data.pending_count}, has_conflicts=${batchStatus1.data.has_conflicts}`);

  const corr1Detail1 = await invokeApi(`/api/corrections/${corr1.data.id}`, 'GET');
  test('更正1详情: has_active_conflicts=true', corr1Detail1, true, 200,
    r => r.data.has_active_conflicts === true && r.data.other_pending_count === 1);
  console.log(`  更正1: has_active_conflicts=${corr1Detail1.data.has_active_conflicts}, other_pending_count=${corr1Detail1.data.other_pending_count}`);

  console.log('\n=== 步骤3: 让第1条更正过期（修改数据库expires_at） ===\n');

  const pastTime = moment().subtract(1, 'hour').format('YYYY-MM-DD HH:mm:ss');
  await run(
    'UPDATE correction_applications SET expires_at = ? WHERE id = ?',
    [pastTime, corr1.data.id]
  );
  console.log(`  已将更正${corr1.data.id}的expires_at设为: ${pastTime}`);

  const verifyDb = await get(
    'SELECT id, status, expires_at FROM correction_applications WHERE id = ?',
    [corr1.data.id]
  );
  console.log(`  数据库验证: id=${verifyDb.id}, status=${verifyDb.status}, expires_at=${verifyDb.expires_at}`);

  console.log('\n=== 步骤4: 查询更正2详情（应触发过期检测并重算冲突） ===\n');

  const corr2Detail = await invokeApi(`/api/corrections/${corr2.data.id}`, 'GET');
  test('更正2详情: 状态仍为PENDING', corr2Detail, true, 200,
    r => r.data.status === 'PENDING');
  console.log(`  更正2状态: ${corr2Detail.data.status}`);
  console.log(`  更正2 status_label: ${corr2Detail.data.status_label}`);
  console.log(`  更正2 conflict_warning: ${corr2Detail.data.conflict_warning}`);
  console.log(`  更正2 has_active_conflicts: ${corr2Detail.data.has_active_conflicts}`);
  console.log(`  更正2 other_pending_count: ${corr2Detail.data.other_pending_count}`);

  test('更正2详情: has_active_conflicts=false（仅剩1条待审，无冲突）', corr2Detail, true, 200,
    r => r.data.has_active_conflicts === false && r.data.other_pending_count === 0);

  test('更正2详情: conflict_warning=0', corr2Detail, true, 200,
    r => r.data.conflict_warning === 0);

  console.log('\n=== 步骤5: 验证更正1已自动标记为过期 ===\n');

  const corr1Detail2 = await invokeApi(`/api/corrections/${corr1.data.id}`, 'GET');
  test('更正1已自动标记为EXPIRED', corr1Detail2, true, 200,
    r => r.data.status === 'EXPIRED' && r.data.status_label === '已过期');
  console.log(`  更正1状态: ${corr1Detail2.data.status} (${corr1Detail2.data.status_label})`);

  console.log('\n=== 步骤6: 验证批次状态已更新 ===\n');

  const batchStatus2 = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  console.log(`  批次 pending_count: ${batchStatus2.data.pending_count}`);
  console.log(`  批次 expired_count: ${batchStatus2.data.expired_count}`);
  console.log(`  批次 has_conflicts: ${batchStatus2.data.has_conflicts}`);

  test('批次状态: pending=1, expired=1, has_conflicts=false', batchStatus2, true, 200,
    r => r.data.pending_count === 1 && 
         r.data.expired_count === 1 && 
         r.data.has_conflicts === false);

  const pendingCorr = batchStatus2.data.all_corrections.find(c => c.status === 'PENDING');
  test('剩余待审更正的conflict_warning已清除为0', batchStatus2, true, 200,
    () => pendingCorr && pendingCorr.conflict_warning === 0);

  console.log('\n=== 步骤7: 验证过期申请不能被审核 ===\n');

  const approveExpired = await invokeApi(`/api/corrections/${corr1.data.id}/review`, 'PUT', {
    reviewer: '赵质控',
    reviewer_type: 'QC',
    review_result: 'APPROVED',
    review_reason: '尝试通过过期申请'
  });
  test('通过过期申请被拒绝（400）', approveExpired, false, 400,
    r => r.error && r.error.includes('已超过审核时限'));
  console.log(`  通过过期: ${approveExpired.error}`);

  const rejectExpired = await invokeApi(`/api/corrections/${corr1.data.id}/review`, 'PUT', {
    reviewer: '赵质控',
    reviewer_type: 'QC',
    review_result: 'REJECTED',
    review_reason: '尝试驳回过期申请'
  });
  test('驳回过期申请被拒绝（400）', rejectExpired, false, 400,
    r => r.error && (r.error.includes('已超过审核时限') || r.error.includes('已过期')));
  console.log(`  驳回过期: ${rejectExpired.error}`);

  console.log('\n=== 步骤8: 验证正常审核不受影响 ===\n');

  const reviewNormal = await invokeApi(`/api/corrections/${corr2.data.id}/review`, 'PUT', {
    reviewer: '赵质控',
    reviewer_type: 'QC',
    review_result: 'APPROVED',
    review_reason: '同意更正，无冲突'
  });
  test('正常审核通过成功', reviewNormal, true, 200,
    r => r.data.status === 'APPROVED');
  console.log(`  正常审核: status=${reviewNormal.data.status}, has_active_conflicts=${reviewNormal.data.has_active_conflicts}`);

  const batchStatus3 = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  test('最终批次状态: pending=0, approved=1, expired=1', batchStatus3, true, 200,
    r => r.data.pending_count === 0 && 
         r.data.approved_count === 1 && 
         r.data.expired_count === 1 &&
         r.data.has_conflicts === false);

  console.log('\n=== 步骤9: 验证异常清单导出显示正确状态 ===\n');

  await invokeApi(`/api/boxes/${boxNo}/status/EXCEPTION_ISOLATED`, 'PUT', {
    operator: '王司机',
    operator_type: 'DRIVER',
    new_custodian: '赵质控',
    new_custodian_type: 'QC',
    exception_reason: '温度超标'
  });

  const exportResult = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  });
  const boxExport = exportResult.data.exceptions.find(e => e.box_no === boxNo);
  
  console.log(`  导出 correction_status:`);
  console.log(`    pending_count: ${boxExport?.correction_status?.pending_count}`);
  console.log(`    expired_count: ${boxExport?.correction_status?.expired_count}`);
  console.log(`    approved_count: ${boxExport?.correction_status?.approved_count}`);
  console.log(`    has_conflicts: ${boxExport?.correction_status?.has_conflicts}`);
  console.log(`    latest_correction.status_label: ${boxExport?.correction_status?.latest_correction?.status_label}`);

  test('导出: expired_count=1, approved_count=1, has_conflicts=false', exportResult, true, 200,
    () => boxExport && 
          boxExport.correction_status.expired_count === 1 &&
          boxExport.correction_status.approved_count === 1 &&
          boxExport.correction_status.has_conflicts === false);

  const printable = exportResult.data.printable_format;
  test('打印格式包含"已过期1条"', exportResult, true, 200,
    () => printable.includes('已过期1条'));
  console.log(`  打印格式包含已过期: ${printable.includes('已过期1条')}`);

  console.log('\n=== 步骤10: 验证审计日志（不重复） ===\n');

  const logs = await invokeApi(`/api/audit-logs?action=CORRECTION_EXPIRED`, 'GET');
  const expiredLogs = logs.data.filter(l =>
    l.details && l.details.includes(`"correction_id":${corr1.data.id}`)
  );
  test('过期审计日志仅1条（无重复）', logs, true, 200,
    r => expiredLogs.length === 1);
  console.log(`  CORRECTION_EXPIRED日志数: ${expiredLogs.length}`);

  if (expiredLogs.length > 0) {
    const details = JSON.parse(expiredLogs[0].details);
    console.log(`  日志: operator=${expiredLogs[0].operator}, expired_at=${details.expired_at}`);
    test('日志操作者为SYSTEM', logs, true, 200,
      () => expiredLogs[0].operator === 'SYSTEM');
    test('日志包含触发时间expired_at', logs, true, 200,
      () => details.expired_at !== undefined);
  }

  const corr1Detail3 = await invokeApi(`/api/corrections/${corr1.data.id}`, 'GET');
  const logsAfter = await invokeApi(`/api/audit-logs?action=CORRECTION_EXPIRED`, 'GET');
  const expiredLogsAfter = logsAfter.data.filter(l =>
    l.details && l.details.includes(`"correction_id":${corr1.data.id}`)
  );
  test('再次查询后日志数仍为1（不重复）', logsAfter, true, 200,
    r => expiredLogsAfter.length === 1);
  console.log(`  再次查询后日志数: ${expiredLogsAfter.length}`);

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
