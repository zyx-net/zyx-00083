const axios = require('axios');

const baseUrl = 'http://localhost:3000';
const testId = Date.now();
const boxNo = `BOX-TEST-${testId}`;
const batchNo = `BATCH-TEST-${testId}`;

let passCount = 0;
let failCount = 0;

async function invokeApi(path, method = 'GET', body = null, expectedSuccess = true, testName) {
  const url = `${baseUrl}${path}`;
  try {
    const axiosConfig = { url, method };
    if (body) {
      axiosConfig.data = body;
      axiosConfig.headers = { 'Content-Type': 'application/json' };
    }
    const response = await axios(axiosConfig);
    const success = expectedSuccess ? response.data.success : !response.data.success;
    if (success) {
      passCount++;
      console.log(`✓ PASS  ${testName}`);
    } else {
      failCount++;
      console.log(`✗ FAIL  ${testName}`);
      console.log(`         Expected: ${expectedSuccess ? 'success' : 'error'}, Got: ${response.data.success ? 'success' : 'error'}`);
      if (response.data.error) console.log(`         Error: ${response.data.error}`);
    }
    return response.data;
  } catch (error) {
    const success = !expectedSuccess && error.response;
    if (success) {
      passCount++;
      console.log(`✓ PASS  ${testName}`);
    } else {
      failCount++;
      console.log(`✗ FAIL  ${testName}`);
      console.log(`         Error: ${error.message}`);
    }
    return error.response ? error.response.data : { error: error.message };
  }
}

async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('  冷链餐盒交接更正功能 - 自动化验证测试');
  console.log('='.repeat(70));
  console.log(`  测试餐盒: ${boxNo}`);
  console.log(`  测试批次: ${batchNo}`);

  console.log('\n--- 基础测试 ---');

  await invokeApi('/api/health', 'GET', null, true, '健康检查正常');
  await invokeApi('/api/config', 'GET', null, true, '获取配置成功');
  await invokeApi('/api/meta/correction-statuses', 'GET', null, true, '获取更正状态列表成功');

  console.log('\n--- 步骤1: 创建测试餐盒并流转 ---');

  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo,
    batch_no: batchNo,
    kitchen_staff: 'Test Chef',
    meal_items: [{ name: 'Test Meal', quantity: 1, price: 25 }]
  }, true, '创建餐盒成功');

  await invokeApi(`/api/boxes/${boxNo}/status/MEAL_PREPARED`, 'PUT', {
    operator: 'Test Chef', operator_type: 'KITCHEN', remark: '出餐'
  }, true, '状态更新为出餐成功');

  await invokeApi(`/api/boxes/${boxNo}/status/BOXED`, 'PUT', {
    operator: 'Test Chef', operator_type: 'KITCHEN', remark: '装箱'
  }, true, '状态更新为装箱成功');

  await invokeApi(`/api/boxes/${boxNo}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: 'Test Chef', operator_type: 'KITCHEN',
    new_custodian: 'Test Driver', new_custodian_type: 'DRIVER',
    temperature: 4.5
  }, true, '状态更新为司机接收成功');

  await invokeApi('/api/temperature', 'POST', {
    box_no: boxNo, temperature: 5.0,
    timestamp: '2026-06-07 13:00:00', recorded_by: 'Test Driver'
  }, true, '温度记录上报成功');

  const boxDetail = await invokeApi(`/api/boxes/${boxNo}`, 'GET', null, true, '获取餐盒详情成功');
  const tempRecordId = boxDetail.data.temperature_readings[0].id;
  const statusRecordId = boxDetail.data.status_history[3].id;

  console.log('\n--- 步骤2: 权限测试 ---');

  await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '4.8',
    apply_reason: 'Test correction', applicant: 'System', applicant_type: 'SYSTEM'
  }, false, 'SYSTEM角色提交更正被拒绝');

  await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '4.8',
    apply_reason: 'Temperature reading error',
    applicant: 'Test Driver', applicant_type: 'DRIVER'
  }, true, 'DRIVER角色提交更正成功');

  const corrections = await invokeApi('/api/corrections', 'GET', null, true, '查询更正列表成功');
  const correctionId = corrections.data[0].id;

  await invokeApi(`/api/corrections/${correctionId}/review`, 'PUT', {
    reviewer: 'Test Driver', reviewer_type: 'DRIVER',
    review_result: 'APPROVED', review_reason: 'OK'
  }, false, 'DRIVER角色审核更正被拒绝');

  await invokeApi(`/api/corrections/${correctionId}/review`, 'PUT', {
    reviewer: 'Test QC', reviewer_type: 'QC',
    review_result: 'APPROVED', review_reason: 'Verified, correction approved'
  }, true, 'QC角色审核通过更正成功');

  const boxAfter = await invokeApi(`/api/boxes/${boxNo}`, 'GET', null, true, '获取更正后餐盒详情成功');
  const correctedTemp = boxAfter.data.temperature_readings[0].temperature;
  if (correctedTemp === 4.8) {
    passCount++;
    console.log('✓ PASS  更正后温度值已更新为4.8');
  } else {
    failCount++;
    console.log(`✗ FAIL  更正后温度值错误，期望4.8，实际${correctedTemp}`);
  }

  console.log('\n--- 步骤3: 冲突检测测试 ---');

  await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'status_history', record_id: statusRecordId,
    field_name: 'operator', proposed_value: 'Driver 2',
    apply_reason: 'Operator error', applicant: 'Store Manager', applicant_type: 'STORE'
  }, true, '提交第二条更正申请成功');

  const corr2 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'box',
    field_name: 'current_custodian', proposed_value: 'Driver 3',
    apply_reason: 'Custodian error', applicant: 'Store Manager', applicant_type: 'STORE'
  }, true, '提交第三条更正申请成功');

  if (corr2.data.conflict_warning === 1) {
    passCount++;
    console.log('✓ PASS  第三条更正检测到冲突警告');
  } else {
    failCount++;
    console.log('✗ FAIL  第三条更正未检测到冲突警告');
  }

  const batchStatus = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET', null, true, '查询批次更正状态成功');
  if (batchStatus.data.has_conflicts) {
    passCount++;
    console.log('✓ PASS  批次状态显示存在冲突');
  } else {
    failCount++;
    console.log('✗ FAIL  批次状态未显示存在冲突');
  }

  console.log('\n--- 步骤4: 导出测试 ---');

  await invokeApi('/api/boxes', 'POST', {
    box_no: `${boxNo}-EXP`,
    batch_no: `${batchNo}-EXP`,
    kitchen_staff: 'Test Chef',
    meal_items: [{ name: 'Test Meal', quantity: 1 }]
  }, true, '创建异常测试餐盒成功');

  await invokeApi(`/api/boxes/${boxNo}-EXP/status/MEAL_PREPARED`, 'PUT', {
    operator: 'Test Chef', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}-EXP/status/BOXED`, 'PUT', {
    operator: 'Test Chef', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}-EXP/status/DRIVER_RECEIVED`, 'PUT', {
    operator: 'Test Chef', operator_type: 'KITCHEN',
    new_custodian: 'Test Driver', new_custodian_type: 'DRIVER',
    temperature: 4.5
  }, true);
  await invokeApi('/api/temperature', 'POST', {
    box_no: `${boxNo}-EXP`, temperature: 15.0,
    timestamp: '2026-06-07 13:00:00', recorded_by: 'Test Driver'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}-EXP/status/EXCEPTION_ISOLATED`, 'PUT', {
    operator: 'Test Driver', operator_type: 'DRIVER',
    new_custodian: 'Test QC', new_custodian_type: 'QC',
    exception_reason: 'Temperature exceeded'
  }, true, '餐盒设置为异常隔离成功');

  const exportResult = await invokeApi('/api/export/exceptions', 'POST', {
    operator: 'Test QC'
  }, true, '导出异常清单成功');

  const exceptionItem = exportResult.data.exceptions.find(e => e.box_no === `${boxNo}-EXP`);
  if (exceptionItem && exceptionItem.correction_status) {
    passCount++;
    console.log('✓ PASS  导出异常清单包含correction_status字段');
    if (exceptionItem.correction_status.pending_count === 0) {
      passCount++;
      console.log('✓ PASS  无更正时pending_count为0');
    } else {
      failCount++;
      console.log('✗ FAIL  无更正时pending_count不为0');
    }
  } else {
    failCount++;
    console.log('✗ FAIL  导出异常清单缺少correction_status字段');
  }

  console.log('\n--- 步骤5: 审计日志测试 ---');

  const auditLogs = await invokeApi(`/api/audit-logs?box_no=${boxNo}`, 'GET', null, true, '查询审计日志成功');
  const correctionLogs = auditLogs.data.filter(l => l.action.startsWith('CORRECTION_'));
  if (correctionLogs.length >= 2) {
    passCount++;
    console.log(`✓ PASS  审计日志包含${correctionLogs.length}条更正相关记录`);
  } else {
    failCount++;
    console.log(`✗ FAIL  审计日志更正记录不足，实际${correctionLogs.length}条`);
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
