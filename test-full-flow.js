const axios = require('axios');

const baseUrl = 'http://localhost:3000';
const boxNo = 'BOX-MAIN-TEST-001';

async function invokeApi(path, method = 'GET', body = null) {
  const url = `${baseUrl}${path}`;
  console.log(`\n=== ${method} ${url} ===`);
  if (body) console.log('Body:', JSON.stringify(body, null, 2));
  try {
    const axiosConfig = {
      url,
      method
    };
    if (body) {
      axiosConfig.data = body;
      axiosConfig.headers = { 'Content-Type': 'application/json' };
    }
    const response = await axios(axiosConfig);
    console.log('Response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    if (error.response) {
      console.log('ERROR Status:', error.response.status);
      console.log('ERROR Body:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log('ERROR:', error.message);
    }
    return null;
  }
}

async function runTests() {
  console.log('\n========================================');
  console.log('  冷链餐盒交付追踪 - 完整验收主链路测试');
  console.log('========================================');

  // 1. 建档
  console.log('\n[1/9] 餐盒建档');
  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo,
    batch_no: 'BATCH-MAIN-TEST-001',
    kitchen_staff: 'Li Chef',
    meal_items: [
      { name: 'Braised Pork Set', quantity: 3, price: 35 },
      { name: 'Vegetable Set', quantity: 2, price: 22 }
    ]
  });

  // 2. 出餐
  console.log('\n[2/9] 出餐');
  await invokeApi(`/api/boxes/${boxNo}/status/MEAL_PREPARED`, 'PUT', {
    operator: 'Li Chef',
    operator_type: 'KITCHEN',
    remark: 'Meal preparation completed'
  });

  // 3. 装箱
  console.log('\n[3/9] 装箱');
  await invokeApi(`/api/boxes/${boxNo}/status/BOXED`, 'PUT', {
    operator: 'Li Chef',
    operator_type: 'KITCHEN',
    remark: 'Boxed, seal no. SEA-2026-TEST-0001'
  });

  // 4. 司机接收
  console.log('\n[4/9] 司机接收');
  await invokeApi(`/api/boxes/${boxNo}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: 'Li Chef',
    operator_type: 'KITCHEN',
    new_custodian: 'Zhang Driver',
    new_custodian_type: 'DRIVER',
    temperature: 4.2,
    remark: 'Handover from kitchen to driver'
  });

  // 5. 运输途中温度上报
  console.log('\n[5/9] 温度上报');
  await invokeApi('/api/temperature', 'POST', {
    box_no: boxNo,
    temperature: 5.1,
    timestamp: '2026-06-07 13:30:00',
    recorded_by: 'Zhang Driver'
  });

  // 6. 门店验收
  console.log('\n[6/9] 门店验收');
  await invokeApi(`/api/boxes/${boxNo}/status/STORE_ACCEPTED`, 'PUT', {
    operator: 'Zhang Driver',
    operator_type: 'DRIVER',
    new_custodian: 'Wang Store Manager',
    new_custodian_type: 'STORE',
    temperature: 4.9,
    timestamp: '2026-06-07 14:00:00',
    remark: 'Store acceptance passed, meals intact'
  });

  // 7. 归档
  console.log('\n[7/9] 归档');
  await invokeApi(`/api/boxes/${boxNo}/status/ARCHIVED`, 'PUT', {
    operator: 'Wang Store Manager',
    operator_type: 'STORE',
    new_custodian: 'System',
    new_custodian_type: 'SYSTEM',
    remark: 'Order completed and archived'
  });

  // 8. 导出交接单
  console.log('\n[8/9] 导出交接单');
  await invokeApi(`/api/export/handover/${boxNo}`, 'POST', {
    operator: 'Wang Store Manager'
  });

  // 9. 查看最终详情
  console.log('\n[9/9] 查看最终详情');
  await invokeApi(`/api/boxes/${boxNo}`, 'GET');

  console.log('\n========================================');
  console.log('  主链路测试完成！');
  console.log('========================================');

  console.log('\n\n========================================');
  console.log('  错误场景测试');
  console.log('========================================');

  // 测试1: 重复箱号建档
  console.log('\n[错误测试1] 重复箱号建档');
  await invokeApi('/api/boxes', 'POST', {
    box_no: boxNo,
    batch_no: 'BATCH-TEST-DUP',
    kitchen_staff: 'Li Chef',
    meal_items: [{ name: 'Test Set', quantity: 1 }]
  });

  // 测试2: 非当前保管人交接
  console.log('\n[错误测试2] 非当前保管人交接');
  await invokeApi(`/api/boxes/${boxNo}/status/STORE_ACCEPTED`, 'PUT', {
    operator: 'Li Chef',
    operator_type: 'KITCHEN',
    new_custodian: 'Some Manager',
    new_custodian_type: 'STORE',
    temperature: 4.9,
    timestamp: '2026-06-07 14:00:00'
  });

  // 测试3: 缺时间戳
  console.log('\n[错误测试3] 验收缺时间戳');
  const testBox2 = 'BOX-ERR-TEST-001';
  await invokeApi('/api/boxes', 'POST', {
    box_no: testBox2,
    batch_no: 'BATCH-ERR-TEST-001',
    kitchen_staff: 'Wang Chef',
    meal_items: [{ name: 'Test Set', quantity: 1 }]
  });
  await invokeApi(`/api/boxes/${testBox2}/status/MEAL_PREPARED`, 'PUT', { operator: 'Wang Chef', operator_type: 'KITCHEN' });
  await invokeApi(`/api/boxes/${testBox2}/status/BOXED`, 'PUT', { operator: 'Wang Chef', operator_type: 'KITCHEN' });
  await invokeApi(`/api/boxes/${testBox2}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: 'Wang Chef', operator_type: 'KITCHEN',
    new_custodian: 'Zhao Driver', new_custodian_type: 'DRIVER'
  });
  await invokeApi(`/api/boxes/${testBox2}/status/STORE_ACCEPTED`, 'PUT', {
    operator: 'Zhao Driver',
    operator_type: 'DRIVER',
    new_custodian: 'Liu Manager',
    new_custodian_type: 'STORE',
    temperature: 4.9
  });

  // 测试4: 非数字温度
  console.log('\n[错误测试4] 非数字温度');
  try {
    const response = await axios({
      url: `${baseUrl}/api/temperature`,
      method: 'POST',
      data: {
        box_no: testBox2,
        temperature: 'abc',
        timestamp: '2026-06-07 14:00:00',
        recorded_by: 'Zhao Driver'
      },
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.log('ERROR Status:', error.response.status);
    console.log('ERROR Body:', JSON.stringify(error.response.data, null, 2));
  }

  // 测试5: 隔离后继续正常验收
  console.log('\n[错误测试5] 异常隔离后尝试正常验收');
  const testBox3 = 'BOX-ISO-TEST-001';
  await invokeApi('/api/boxes', 'POST', {
    box_no: testBox3,
    batch_no: 'BATCH-ISO-TEST-001',
    kitchen_staff: 'Sun Chef',
    meal_items: [{ name: 'Test Set', quantity: 1 }]
  });
  await invokeApi(`/api/boxes/${testBox3}/status/MEAL_PREPARED`, 'PUT', { operator: 'Sun Chef', operator_type: 'KITCHEN' });
  await invokeApi(`/api/boxes/${testBox3}/status/BOXED`, 'PUT', { operator: 'Sun Chef', operator_type: 'KITCHEN' });
  await invokeApi(`/api/boxes/${testBox3}/status/DRIVER_RECEIVED`, 'PUT', {
    operator: 'Sun Chef', operator_type: 'KITCHEN',
    new_custodian: 'Zhou Driver', new_custodian_type: 'DRIVER'
  });
  await invokeApi(`/api/boxes/${testBox3}/status/EXCEPTION_ISOLATED`, 'PUT', {
    operator: 'Zhou Driver',
    operator_type: 'DRIVER',
    new_custodian: 'Zheng QC',
    new_custodian_type: 'QC',
    exception_reason: 'Temperature exceeded during transport',
    remark: 'Exception isolation'
  });
  await invokeApi(`/api/boxes/${testBox3}/status/STORE_ACCEPTED`, 'PUT', {
    operator: 'Zheng QC',
    operator_type: 'QC',
    new_custodian: 'Wu Manager',
    new_custodian_type: 'STORE',
    temperature: 4.9,
    timestamp: '2026-06-07 14:00:00'
  });

  console.log('\n========================================');
  console.log('  所有测试完成！');
  console.log('========================================');

  console.log('\n\n=== 数据持久化验证查询 ===');
  console.log('\n查询样例餐盒 BOX-SAMPLE-001:');
  await invokeApi('/api/boxes/BOX-SAMPLE-001', 'GET');

  console.log('\n查询配置版本:');
  await invokeApi('/api/configs', 'GET');

  console.log('\n查询审计日志:');
  await invokeApi(`/api/audit-logs?box_no=${boxNo}`, 'GET');

  console.log('\n查询导出历史:');
  await invokeApi('/api/export-history', 'GET');
}

runTests().catch(console.error);
