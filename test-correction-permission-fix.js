const axios = require('axios');

const baseUrl = 'http://localhost:3000';
const testId = Date.now();
const boxNo = `BOX-PERM-FIX-${testId}`;
const batchNo = `BATCH-PERM-FIX-${testId}`;

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
    const result = {
      ...response.data,
      status: response.status,
      is_success: response.data.success === true,
      is_error: response.data.success === false
    };
    return result;
  } catch (error) {
    return {
      error: error.message,
      status: error.response ? error.response.status : 0,
      is_success: false,
      is_error: true
    };
  }
}

function test(testName, result, expectedSuccess, expectedStatusCode = null) {
  const success = (result.is_success === expectedSuccess) && 
                  (expectedStatusCode ? result.status === expectedStatusCode : true);
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
  }
}

async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('  更正申请角色权限修复 - 验证测试');
  console.log('='.repeat(70));
  console.log(`  测试餐盒: ${boxNo}`);
  console.log(`  测试批次: ${batchNo}`);

  console.log('\n--- 准备测试数据 ---');

  const createBox = await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo,
    batch_no: batchNo,
    kitchen_staff: '张厨师',
    meal_items: [{ name: '测试套餐', quantity: 1, price: 25 }]
  });
  test('创建测试餐盒', createBox, true, 201);

  const boxDetail = await invokeApi(`/api/boxes/${boxNo}`, 'GET');
  test('获取餐盒详情', boxDetail, true, 200);
  const statusRecordId = boxDetail.data.status_history[0].id;

  console.log('\n--- 初始状态验证 ---');

  const correctionsBefore = await invokeApi(`/api/corrections?box_no=${boxNo}`, 'GET');
  test('初始更正列表为空', correctionsBefore, true, 200);
  if (correctionsBefore.data?.length === 0) {
    passCount++;
    console.log('✓ PASS  初始状态: 0条更正申请');
  } else {
    failCount++;
    console.log(`✗ FAIL  初始状态: ${correctionsBefore.data?.length}条更正申请（应为0）`);
  }

  console.log('\n=== 测试1: KITCHEN 角色提交更正被拒绝 (403) ===');

  const kitchenSubmit = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo,
    record_type: 'status_history',
    record_id: statusRecordId,
    field_name: 'operator',
    proposed_value: '越权修改人',
    apply_reason: '测试KITCHEN越权',
    applicant: '张厨师',
    applicant_type: 'KITCHEN'
  });
  test('KITCHEN角色提交更正返回403', kitchenSubmit, false, 403);

  if (kitchenSubmit.error?.includes('没有提交更正申请的权限')) {
    passCount++;
    console.log('✓ PASS  错误消息包含权限提示');
    console.log(`         Message: ${kitchenSubmit.error}`);
  } else {
    failCount++;
    console.log(`✗ FAIL  错误消息不正确`);
    console.log(`         Message: ${kitchenSubmit.error}`);
  }

  console.log('\n--- 验证 KITCHEN 被拒后无副作用 ---');

  const correctionsAfterKitchen = await invokeApi(`/api/corrections?box_no=${boxNo}`, 'GET');
  test('KITCHEN被拒后更正列表仍为空', correctionsAfterKitchen, true, 200);
  if (correctionsAfterKitchen.data?.length === 0) {
    passCount++;
    console.log('✓ PASS  KITCHEN被拒后无更正申请写入数据库');
  } else {
    failCount++;
    console.log(`✗ FAIL  KITCHEN被拒后更正数量: ${correctionsAfterKitchen.data?.length}（应为0）`);
    console.log(`         Details:`, JSON.stringify(correctionsAfterKitchen.data, null, 2));
  }

  const batchStatusAfterKitchen = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  test('批次状态查询正常', batchStatusAfterKitchen, true, 200);
  if (batchStatusAfterKitchen.data?.pending_count === 0) {
    passCount++;
    console.log('✓ PASS  批次状态无待审更正');
  } else {
    failCount++;
    console.log(`✗ FAIL  批次状态待审计数: ${batchStatusAfterKitchen.data?.pending_count}`);
  }
  if (batchStatusAfterKitchen.data?.has_conflicts === false) {
    passCount++;
    console.log('✓ PASS  批次状态无冲突标记');
  } else {
    failCount++;
    console.log(`✗ FAIL  批次状态has_conflicts: ${batchStatusAfterKitchen.data?.has_conflicts}`);
  }
  if (batchStatusAfterKitchen.data?.total_corrections === 0) {
    passCount++;
    console.log('✓ PASS  批次状态无任何更正记录');
  } else {
    failCount++;
    console.log(`✗ FAIL  批次状态总更正数: ${batchStatusAfterKitchen.data?.total_corrections}`);
  }

  const auditLogsAfterKitchen = await invokeApi(`/api/audit-logs?box_no=${boxNo}`, 'GET');
  test('审计日志查询正常', auditLogsAfterKitchen, true, 200);
  const correctionLogs = auditLogsAfterKitchen.data?.filter(l => l.action.startsWith('CORRECTION_')) || [];
  if (correctionLogs.length === 0) {
    passCount++;
    console.log('✓ PASS  无更正相关审计日志');
  } else {
    failCount++;
    console.log(`✗ FAIL  更正审计日志数量: ${correctionLogs.length}`);
    correctionLogs.forEach(log => console.log(`         - ${log.action}: ${log.details}`));
  }

  console.log('\n=== 测试2: SYSTEM 角色提交被拒绝 (403) ===');

  const systemSubmit = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo,
    record_type: 'status_history',
    record_id: statusRecordId,
    field_name: 'operator',
    proposed_value: '越权修改人',
    apply_reason: '测试SYSTEM越权',
    applicant: 'System',
    applicant_type: 'SYSTEM'
  });
  test('SYSTEM角色提交更正返回403', systemSubmit, false, 403);

  const correctionsAfterSystem = await invokeApi(`/api/corrections?box_no=${boxNo}`, 'GET');
  if (correctionsAfterSystem.data?.length === 0) {
    passCount++;
    console.log('✓ PASS  SYSTEM被拒后仍无更正申请');
  } else {
    failCount++;
    console.log(`✗ FAIL  SYSTEM被拒后更正数量: ${correctionsAfterSystem.data?.length}`);
  }

  console.log('\n=== 测试3: 验证合法角色仍可正常提交 ===');

  console.log('\n  DRIVER 角色:');
  const driverSubmit = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo,
    record_type: 'status_history',
    record_id: statusRecordId,
    field_name: 'operator',
    proposed_value: '修正后的操作人',
    apply_reason: '操作人填写错误',
    applicant: '李司机',
    applicant_type: 'DRIVER'
  });
  test('DRIVER角色提交更正成功', driverSubmit, true, 201);
  const driverCorrectionId = driverSubmit.data?.id;
  console.log(`         更正ID: ${driverCorrectionId}`);

  console.log('\n  STORE 角色:');
  const storeSubmit = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo,
    record_type: 'status_history',
    record_id: statusRecordId,
    field_name: 'operator',
    proposed_value: '另一位操作人',
    apply_reason: '再次修正操作人',
    applicant: '王店长',
    applicant_type: 'STORE'
  });
  test('STORE角色提交更正成功', storeSubmit, true, 201);

  console.log('\n  QC 角色:');
  const qcSubmit = await invokeApi('/api/corrections', 'POST', {
    box_no: boxNo,
    record_type: 'status_history',
    record_id: statusRecordId,
    field_name: 'operator',
    proposed_value: 'QC修正操作人',
    apply_reason: '质控发现填写错误',
    applicant: '赵质控',
    applicant_type: 'QC'
  });
  test('QC角色提交更正成功', qcSubmit, true, 201);

  const correctionsAfterValid = await invokeApi(`/api/corrections?box_no=${boxNo}`, 'GET');
  if (correctionsAfterValid.data?.length === 3) {
    passCount++;
    console.log('✓ PASS  合法角色提交的3条更正已保存');
  } else {
    failCount++;
    console.log(`✗ FAIL  更正数量应为3，实际${correctionsAfterValid.data?.length}`);
  }

  console.log('\n--- 验证冲突检测正常工作 ---');

  const batchStatusAfterValid = await invokeApi(`/api/corrections/batch/${batchNo}/status`, 'GET');
  if (batchStatusAfterValid.data?.pending_count === 3) {
    passCount++;
    console.log('✓ PASS  批次状态显示3条待审');
  } else {
    failCount++;
    console.log(`✗ FAIL  待审计数: ${batchStatusAfterValid.data?.pending_count}`);
  }
  if (batchStatusAfterValid.data?.has_conflicts === true) {
    passCount++;
    console.log('✓ PASS  批次状态显示冲突');
  } else {
    failCount++;
    console.log(`✗ FAIL  冲突状态不正确: ${batchStatusAfterValid.data?.has_conflicts}`);
  }

  console.log('\n=== 测试4: 审核权限验证 ===');

  console.log('\n  DRIVER 角色尝试审核:');
  const driverReview = await invokeApi(`/api/corrections/${driverCorrectionId}/review`, 'PUT', {
    reviewer: '李司机',
    reviewer_type: 'DRIVER',
    review_result: 'APPROVED',
    review_reason: '越权审核'
  });
  test('DRIVER角色审核被拒绝', driverReview, false, 403);
  if (driverReview.error?.includes('没有审核更正申请的权限')) {
    passCount++;
    console.log('✓ PASS  DRIVER审核错误消息正确');
  } else {
    failCount++;
    console.log(`✗ FAIL  错误消息: ${driverReview.error}`);
  }

  console.log('\n  QC 角色审核:');
  const qcReview = await invokeApi(`/api/corrections/${driverCorrectionId}/review`, 'PUT', {
    reviewer: '赵质控',
    reviewer_type: 'QC',
    review_result: 'APPROVED',
    review_reason: '经核实同意修正'
  });
  test('QC角色审核通过', qcReview, true, 200);

  console.log('\n=== 测试5: 验证导出功能不受影响 ===');

  const exportResult = await invokeApi('/api/export/exceptions', 'POST', {
    operator: '赵质控'
  });
  test('导出异常清单成功', exportResult, true, 200);

  const boxInExport = exportResult.data?.exceptions?.find(e => e.box_no === boxNo);
  if (!boxInExport) {
    passCount++;
    console.log('✓ PASS  非异常餐盒不在异常导出中');
  } else {
    failCount++;
    console.log(`✗ FAIL  正常餐盒出现在异常导出中`);
  }

  if (exportResult.data?.exceptions?.length > 0) {
    const sampleException = exportResult.data.exceptions[0];
    if (sampleException.correction_status) {
      passCount++;
      console.log('✓ PASS  异常导出包含correction_status字段');
    } else {
      failCount++;
      console.log(`✗ FAIL  异常导出缺少correction_status字段`);
    }
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
