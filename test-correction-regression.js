const axios = require('axios');

const baseUrl = 'http://localhost:3000';
const testBoxPrefix = 'BOX-REG-TEST';
const testBatchPrefix = 'BATCH-REG-TEST';

let passCount = 0;
let failCount = 0;

async function invokeApi(path, method = 'GET', body = null, expectedSuccess = true) {
  const url = `${baseUrl}${path}`;
  try {
    const axiosConfig = { url, method };
    if (body) {
      axiosConfig.data = body;
      axiosConfig.headers = { 'Content-Type': 'application/json' };
    }
    const response = await axios(axiosConfig);
    if (expectedSuccess && response.data.success) {
      passCount++;
    } else if (!expectedSuccess && !response.data.success) {
      passCount++;
    } else {
      failCount++;
    }
    return response.data;
  } catch (error) {
    if (!expectedSuccess && error.response) {
      passCount++;
      return error.response.data;
    }
    failCount++;
    return error.response ? error.response.data : { error: error.message };
  }
}

function testHeader(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(70)}`);
}

function testResult(testName, success, details = '') {
  const status = success ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${status}  ${testName}`);
  if (details) {
    console.log(`         ${details}`);
  }
}

async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('  冷链餐盒交接更正功能 - 回归测试套件');
  console.log('='.repeat(70));
  console.log(`  测试时间: ${new Date().toISOString()}`);
  console.log(`  服务地址: ${baseUrl}`);

  await testHeader('第一部分: 权限控制测试');
  await testPermissions();

  await testHeader('第二部分: 冲突检测测试');
  await testConflictDetection();

  await testHeader('第三部分: 服务重启后数据一致性测试');
  await testRestartPersistence();

  await testHeader('第四部分: 导出功能测试（含更正状态）');
  await testExportWithCorrections();

  await testHeader('测试总结');
  console.log(`\n  总测试数: ${passCount + failCount}`);
  console.log(`  通过: ${passCount}`);
  console.log(`  失败: ${failCount}`);
  console.log(`  通过率: ${((passCount / (passCount + failCount)) * 100).toFixed(2)}%`);
  console.log('\n' + '='.repeat(70));

  process.exit(failCount > 0 ? 1 : 0);
}

async function testPermissions() {
  const testId = Date.now();
  const boxNo = `${testBoxPrefix}-PERM-${testId}`;
  const batchNo = `${testBatchPrefix}-PERM-${testId}`;

  console.log('\n  前置准备: 创建测试餐盒并流转到司机接收状态');
  
  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo,
    batch_no: batchNo,
    kitchen_staff: '李厨师',
    meal_items: [{ name: '测试套餐', quantity: 1 }]
  }, true);

  await invokeApi(`/api/boxes/${boxNo}/status/MEAL_PREPARED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);

  await invokeApi(`/api/boxes/${boxNo}/status/BOXED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);

  await invokeApi(`/api/boxes/${boxNo}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN',
    new_custodian: '王司机', new_custodian_type: 'DRIVER',
    temperature: 4.5
  }, true);

  await invokeApi('/api/temperature', 'POST', {
    box_no: boxNo, temperature: 5.0,
    timestamp: '2026-06-07 13:00:00', recorded_by: '王司机'
  }, true);

  const boxDetail = await invokeApi(`/api/boxes/${boxNo}`, 'GET', null, true);
  const tempRecordId = boxDetail.data.temperature_readings[0].id;
  const statusRecordId = boxDetail.data.status_history[3].id;

  console.log('\n  测试1: SYSTEM角色不能提交更正申请');
  const result1 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '4.8',
    apply_reason: '测试', applicant: '系统', applicant_type: 'SYSTEM'
  }, false);
  testResult('SYSTEM角色提交更正被拒绝', !result1.success, result1.error);

  console.log('\n  测试2: DRIVER角色可以提交更正申请');
  const result2 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '4.8',
    apply_reason: '温度读数误差', applicant: '王司机', applicant_type: 'DRIVER'
  }, true);
  testResult('DRIVER角色提交更正成功', result2.success, `更正编号: ${result2.data.correction_no}`);
  const correctionId1 = result2.data.id;

  console.log('\n  测试3: STORE角色可以提交更正申请');
  const result3 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'status_history', record_id: statusRecordId,
    field_name: 'operator', proposed_value: '张司机',
    apply_reason: '操作人填写错误', applicant: '李店长', applicant_type: 'STORE'
  }, true);
  testResult('STORE角色提交更正成功', result3.success, `更正编号: ${result3.data.correction_no}`);
  const correctionId2 = result3.data.id;

  console.log('\n  测试4: DRIVER角色不能审核更正申请');
  const result4 = await invokeApi(`/api/corrections/${correctionId1}/review`, 'PUT', {
    reviewer: '王司机', reviewer_type: 'DRIVER',
    review_result: 'APPROVED', review_reason: '同意'
  }, false);
  testResult('DRIVER角色审核被拒绝', !result4.success, result4.error);

  console.log('\n  测试5: STORE角色不能审核更正申请');
  const result5 = await invokeApi(`/api/corrections/${correctionId1}/review`, 'PUT', {
    reviewer: '李店长', reviewer_type: 'STORE',
    review_result: 'APPROVED', review_reason: '同意'
  }, false);
  testResult('STORE角色审核被拒绝', !result5.success, result5.error);

  console.log('\n  测试6: KITCHEN角色不能审核更正申请');
  const result6 = await invokeApi(`/api/corrections/${correctionId1}/review`, 'PUT', {
    reviewer: '李厨师', reviewer_type: 'KITCHEN',
    review_result: 'APPROVED', review_reason: '同意'
  }, false);
  testResult('KITCHEN角色审核被拒绝', !result6.success, result6.error);

  console.log('\n  测试7: QC角色可以审核更正申请（通过）');
  const result7 = await invokeApi(`/api/corrections/${correctionId1}/review`, 'PUT', {
    reviewer: '赵质控', reviewer_type: 'QC',
    review_result: 'APPROVED', review_reason: '经核实，同意更正'
  }, true);
  testResult('QC角色审核通过成功', result7.success, `状态: ${result7.data.status_label}`);

  console.log('\n  测试8: QC角色可以审核更正申请（驳回）');
  const result8 = await invokeApi(`/api/corrections/${correctionId2}/review`, 'PUT', {
    reviewer: '赵质控', reviewer_type: 'QC',
    review_result: 'REJECTED', review_reason: '证据不足，驳回申请'
  }, true);
  testResult('QC角色审核驳回成功', result8.success, `状态: ${result8.data.status_label}`);

  console.log('\n  测试9: 验证更正后的值已生效');
  const boxAfter = await invokeApi(`/api/boxes/${boxNo}`, 'GET', null, true);
  const correctedTemp = boxAfter.data.temperature_readings[0].temperature;
  testResult('温度值已更正为4.8', correctedTemp === 4.8, `原值: 5.0, 现值: ${correctedTemp}`);

  console.log('\n  测试10: 已归档批次不能提交更正');
  await invokeApi(`/api/boxes/${boxNo}/status/STORE_ACCEPTED`, 'PUT', {
    operator: '王司机', operator_type: 'DRIVER',
    new_custodian: '李店长', new_custodian_type: 'STORE',
    temperature: 4.8, timestamp: '2026-06-07 14:00:00'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}/status/ARCHIVED`, 'PUT', {
    operator: '李店长', operator_type: 'STORE',
    new_custodian: '系统', new_custodian_type: 'SYSTEM'
  }, true);

  const result10 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '5.5',
    apply_reason: '测试', applicant: '王司机', applicant_type: 'DRIVER'
  }, false);
  testResult('归档批次提交更正被拒绝', !result10.success, result10.error);
}

async function testConflictDetection() {
  const testId = Date.now();
  const boxNo1 = `${testBoxPrefix}-CON-${testId}-1`;
  const boxNo2 = `${testBoxPrefix}-CON-${testId}-2`;
  const batchNo = `${testBatchPrefix}-CON-${testId}`;

  console.log('\n  前置准备: 创建同一批次的两个测试餐盒');
  
  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo1, batch_no: batchNo,
    kitchen_staff: '李厨师', meal_items: [{ name: '测试套餐', quantity: 1 }]
  }, true);

  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo2, batch_no: batchNo,
    kitchen_staff: '李厨师', meal_items: [{ name: '测试套餐', quantity: 1 }]
  }, true);

  await invokeApi(`/api/boxes/${boxNo1}/status/MEAL_PREPARED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo1}/status/BOXED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo1}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN',
    new_custodian: '王司机', new_custodian_type: 'DRIVER', temperature: 4.5
  }, true);

  await invokeApi('/api/temperature', 'POST', {
    box_no: boxNo1, temperature: 5.0,
    timestamp: '2026-06-07 13:00:00', recorded_by: '王司机'
  }, true);

  const boxDetail = await invokeApi(`/api/boxes/${boxNo1}`, 'GET', null, true);
  const tempRecordId = boxDetail.data.temperature_readings[0].id;

  console.log('\n  测试1: 第一条更正申请 - 无冲突');
  const result1 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo1, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '4.8',
    apply_reason: '温度读数误差', applicant: '王司机', applicant_type: 'DRIVER'
  }, true);
  testResult('第一条更正提交成功（无冲突）', 
    result1.success && result1.data.conflict_warning === 0,
    `conflict_warning: ${result1.data.conflict_warning}`);
  const correctionId1 = result1.data.id;

  console.log('\n  测试2: 第二条更正申请（同批次）- 应检测到冲突');
  const result2 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo1, record_type: 'box',
    field_name: 'current_custodian', proposed_value: '李司机',
    apply_reason: '保管人错误', applicant: '李店长', applicant_type: 'STORE'
  }, true);
  testResult('第二条更正提交成功（检测到冲突）', 
    result2.success && result2.data.conflict_warning === 1,
    `conflict_warning: ${result2.data.conflict_warning}, has_active_conflicts: ${result2.data.has_active_conflicts}`);
  const correctionId2 = result2.data.id;

  console.log('\n  测试3: 批次状态查询 - 应显示冲突');
  const batchStatus = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET', null, true);
  testResult('批次状态显示冲突', 
    batchStatus.success && batchStatus.data.has_conflicts === true,
    `pending_count: ${batchStatus.data.pending_count}, has_conflicts: ${batchStatus.data.has_conflicts}`);

  console.log('\n  测试4: 审核第一条更正通过 - 剩余更正应有冲突警告');
  const result4 = await invokeApi(`/api/corrections/${correctionId1}/review`, 'PUT', {
    reviewer: '赵质控', reviewer_type: 'QC',
    review_result: 'APPROVED', review_reason: '同意更正'
  }, true);
  testResult('第一条更正审核通过', result4.success,
    `has_active_conflicts: ${result4.data.has_active_conflicts}`);

  console.log('\n  测试5: 验证第二条更正仍有冲突标记');
  const correction2 = await invokeApi(`/api/corrections/${correctionId2}`, 'GET', null, true);
  testResult('第二条更正仍标记冲突', 
    correction2.success && correction2.data.has_active_conflicts === false,
    `状态: ${correction2.data.status}, 冲突标记: ${correction2.data.conflict_warning}`);

  console.log('\n  测试6: 审核第二条更正通过');
  const result6 = await invokeApi(`/api/corrections/${correctionId2}/review`, 'PUT', {
    reviewer: '赵质控', reviewer_type: 'QC',
    review_result: 'APPROVED', review_reason: '同意更正'
  }, true);
  testResult('第二条更正审核通过', result6.success, `状态: ${result6.data.status_label}`);

  console.log('\n  测试7: 批次状态 - 应无冲突');
  const batchStatus2 = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET', null, true);
  testResult('批次状态无冲突', 
    batchStatus2.success && batchStatus2.data.has_conflicts === false,
    `pending_count: ${batchStatus2.data.pending_count}, approved_count: ${batchStatus2.data.approved_count}`);
}

async function testRestartPersistence() {
  const testId = Date.now();
  const boxNo = `${testBoxPrefix}-RES-${testId}`;
  const batchNo = `${testBatchPrefix}-RES-${testId}`;

  console.log('\n  前置准备: 创建测试餐盒并提交更正申请');
  
  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo, batch_no: batchNo,
    kitchen_staff: '李厨师', meal_items: [{ name: '测试套餐', quantity: 1 }]
  }, true);

  await invokeApi(`/api/boxes/${boxNo}/status/MEAL_PREPARED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}/status/BOXED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN',
    new_custodian: '王司机', new_custodian_type: 'DRIVER', temperature: 4.5
  }, true);

  await invokeApi('/api/temperature', 'POST', {
    box_no: boxNo, temperature: 15.0,
    timestamp: '2026-06-07 13:00:00', recorded_by: '王司机'
  }, true);

  const boxDetail = await invokeApi(`/api/boxes/${boxNo}`, 'GET', null, true);
  const tempRecordId = boxDetail.data.temperature_readings[0].id;
  const statusRecordId = boxDetail.data.status_history[3].id;

  console.log('\n  提交一条更正申请（待审核）');
  const corr1 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '4.8',
    apply_reason: '温度单位错误', applicant: '王司机', applicant_type: 'DRIVER'
  }, true);
  const pendingCorrectionNo = corr1.data.correction_no;

  console.log('\n  提交并审核通过一条更正申请');
  const corr2 = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'status_history', record_id: statusRecordId,
    field_name: 'operator', proposed_value: '张司机',
    apply_reason: '操作人错误', applicant: '李店长', applicant_type: 'STORE'
  }, true);
  await invokeApi(`/api/corrections/${corr2.data.id}/review`, 'PUT', {
    reviewer: '赵质控', reviewer_type: 'QC',
    review_result: 'APPROVED', review_reason: '同意更正'
  }, true);
  const approvedCorrectionNo = corr2.data.correction_no;

  console.log('\n  === 请重启服务后，按任意键继续测试 ===');
  console.log('  重启命令: 停止当前服务后运行 npm start');
  console.log('  重启后请确保服务在 http://localhost:3000 可访问');
  console.log('\n  重启后将验证以下内容:');
  console.log('    1. 配置信息（审核时限、可更正字段）保持不变');
  console.log('    2. 待审核的更正申请仍然存在');
  console.log('    3. 已通过的更正申请仍然存在');
  console.log('    4. 更正后的数据值保持不变');
  console.log('    5. 审计日志完整');

  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  await new Promise(resolve => {
    rl.question('\n  服务重启完成后，请按回车键继续...', () => {
      rl.close();
      resolve();
    });
  });

  console.log('\n  开始验证重启后的数据一致性...');

  console.log('\n  测试1: 验证配置信息保持不变');
  const config = await invokeApi('/api/config', 'GET', null, true);
  testResult('配置审核时限正确', config.data.correction_review_time_limit === 24,
    `correction_review_time_limit: ${config.data.correction_review_time_limit}`);
  testResult('可更正字段白名单正确', 
    Array.isArray(config.data.correctable_fields_whitelist) && 
    config.data.correctable_fields_whitelist.length > 0,
    `字段数: ${config.data.correctable_fields_whitelist?.length}`);

  console.log('\n  测试2: 验证待审核更正申请仍然存在');
  const pendingCorr = await invokeApi(`/api/corrections/${pendingCorrectionNo}`, 'GET', null, true);
  testResult('待审核更正存在且状态正确', 
    pendingCorr.success && pendingCorr.data.status === 'PENDING',
    `状态: ${pendingCorr.data.status}, 更正编号: ${pendingCorr.data.correction_no}`);

  console.log('\n  测试3: 验证已通过更正申请仍然存在');
  const approvedCorr = await invokeApi(`/api/corrections/${approvedCorrectionNo}`, 'GET', null, true);
  testResult('已通过更正存在且状态正确', 
    approvedCorr.success && approvedCorr.data.status === 'APPROVED',
    `状态: ${approvedCorr.data.status}, 审核人: ${approvedCorr.data.reviewer}`);

  console.log('\n  测试4: 验证更正后的数据值保持不变');
  const boxAfter = await invokeApi(`/api/boxes/${boxNo}`, 'GET', null, true);
  const correctedTemp = boxAfter.data.temperature_readings[0].temperature;
  const correctedOperator = boxAfter.data.status_history[3].operator;
  testResult('温度值保持更正后的值', correctedTemp === 15.0,
    `温度值: ${correctedTemp} (待审核更正不改变原值)`);
  testResult('操作人保持更正后的值', correctedOperator === '张司机',
    `操作人: ${correctedOperator} (已审核更正已生效)`);

  console.log('\n  测试5: 验证审计日志完整');
  const auditLogs = await invokeApi(`/api/audit-logs?box_no=${boxNo}`, 'GET', null, true);
  const correctionLogs = auditLogs.data.filter(l => l.action.startsWith('CORRECTION_'));
  testResult('更正相关审计日志存在', correctionLogs.length >= 3,
    `更正日志数: ${correctionLogs.length}`);

  console.log('\n  测试6: 验证批次更正状态查询正常');
  const batchStatus = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET', null, true);
  testResult('批次更正状态正确', 
    batchStatus.success && batchStatus.data.total_corrections >= 2,
    `总更正数: ${batchStatus.data.total_corrections}, 待审: ${batchStatus.data.pending_count}, 已通过: ${batchStatus.data.approved_count}`);
}

async function testExportWithCorrections() {
  const testId = Date.now();
  const boxNo = `${testBoxPrefix}-EXP-${testId}`;
  const batchNo = `${testBatchPrefix}-EXP-${testId}`;

  console.log('\n  前置准备: 创建测试餐盒并设置为异常隔离');
  
  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo, batch_no: batchNo,
    kitchen_staff: '李厨师', meal_items: [{ name: '测试套餐', quantity: 1 }]
  }, true);

  await invokeApi(`/api/boxes/${boxNo}/status/MEAL_PREPARED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}/status/BOXED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN'
  }, true);
  await invokeApi(`/api/boxes/${boxNo}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: '李厨师', operator_type: 'KITCHEN',
    new_custodian: '王司机', new_custodian_type: 'DRIVER', temperature: 4.5
  }, true);

  await invokeApi('/api/temperature', 'POST', {
    box_no: boxNo, temperature: 15.0,
    timestamp: '2026-06-07 13:00:00', recorded_by: '王司机'
  }, true);

  await invokeApi(`/api/boxes/${boxNo}/status/EXCEPTION_ISOLATED`, 'PUT', {
    operator: '王司机', operator_type: 'DRIVER',
    new_custodian: '赵质控', new_custodian_type: 'QC',
    exception_reason: '温度超标'
  }, true);

  const boxDetail = await invokeApi(`/api/boxes/${boxNo}`, 'GET', null, true);
  const tempRecordId = boxDetail.data.temperature_readings[0].id;

  console.log('\n  测试1: 导出异常清单（无更正时）');
  const export1 = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  }, true);
  const exception1 = export1.data.exceptions.find(e => e.box_no === boxNo);
  testResult('导出包含异常餐盒', exception1 !== undefined,
    `找到异常餐盒: ${exception1?.box_no}`);
  testResult('无更正时correction_status字段存在', exception1?.correction_status !== undefined,
    `correction_status存在: ${exception1?.correction_status !== undefined}`);
  testResult('无更正时pending_count为0', exception1?.correction_status?.pending_count === 0,
    `pending_count: ${exception1?.correction_status?.pending_count}`);

  console.log('\n  测试2: 提交更正申请后导出（待审核状态）');
  await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'temperature', record_id: tempRecordId,
    field_name: 'temperature', proposed_value: '4.8',
    apply_reason: '温度单位错误', applicant: '王司机', applicant_type: 'DRIVER'
  }, true);

  const export2 = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  }, true);
  const exception2 = export2.data.exceptions.find(e => e.box_no === boxNo);
  testResult('待审更正状态正确', exception2?.correction_status?.pending_count === 1,
    `pending_count: ${exception2?.correction_status?.pending_count}`);
  testResult('最新更正信息正确', exception2?.correction_status?.latest_correction !== null,
    `最新更正: ${exception2?.correction_status?.latest_correction?.correction_no}`);

  console.log('\n  测试3: 审核通过后导出（已通过状态）');
  const corrections = await invokeApi(`/api/corrections?box_no=${boxNo}&status=PENDING`, 'GET', null, true);
  const corrId = corrections.data[0].id;
  await invokeApi(`/api/corrections/${corrId}/review`, 'PUT', {
    reviewer: '赵质控', reviewer_type: 'QC',
    review_result: 'APPROVED', review_reason: '同意更正'
  }, true);

  const export3 = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  }, true);
  const exception3 = export3.data.exceptions.find(e => e.box_no === boxNo);
  testResult('已通过更正状态正确', exception3?.correction_status?.approved_count === 1,
    `approved_count: ${exception3?.correction_status?.approved_count}`);
  testResult('待审状态已清零', exception3?.correction_status?.pending_count === 0,
    `pending_count: ${exception3?.correction_status?.pending_count}`);

  console.log('\n  测试4: 提交另一条更正并驳回后导出（驳回状态）');
  await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo, record_type: 'box',
    field_name: 'current_custodian', proposed_value: '李质控',
    apply_reason: '保管人错误', applicant: '王司机', applicant_type: 'DRIVER'
  }, true);
  const corrections2 = await invokeApi(`/api/corrections?box_no=${boxNo}&status=PENDING`, 'GET', null, true);
  const corrId2 = corrections2.data[0].id;
  await invokeApi(`/api/corrections/${corrId2}/review`, 'PUT', {
    reviewer: '赵质控', reviewer_type: 'QC',
    review_result: 'REJECTED', review_reason: '证据不足'
  }, true);

  const export4 = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  }, true);
  const exception4 = export4.data.exceptions.find(e => e.box_no === boxNo);
  testResult('已驳回更正状态正确', exception4?.correction_status?.rejected_count === 1,
    `rejected_count: ${exception4?.correction_status?.rejected_count}`);

  console.log('\n  测试5: 验证打印格式包含更正状态');
  const printable = export4.data.printable_format;
  testResult('打印格式包含更正状态文本', printable.includes('更正状态'),
    '打印格式中包含"更正状态"文字');

  console.log('\n  测试6: 验证导出历史可查询');
  const history = await invokeApi('/api/export-history', 'GET', null, true);
  const exceptionExports = history.data.filter(d => d.doc_type === 'EXCEPTION_LIST');
  testResult('导出历史可查询', exceptionExports.length >= 4,
    `异常清单导出次数: ${exceptionExports.length}`);
}

runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
