const { get, run } = require('../database/init');
const { getActiveConfig } = require('../config/configManager');
const moment = require('moment');

const SAMPLE_BOXES = [
  {
    box_no: 'BOX-SAMPLE-001',
    batch_no: 'BATCH-2026-0601-001',
    kitchen_staff: '张厨师',
    meal_items: [
      { name: '红烧肉套餐', quantity: 2, price: 35 },
      { name: '清蒸鱼套餐', quantity: 2, price: 45 },
      { name: '番茄炒蛋套餐', quantity: 1, price: 25 }
    ],
    status: 'STORE_ACCEPTED',
    current_custodian: '李店长',
    custodian_type: 'STORE',
    driver: '王司机',
    store_staff: '李店长'
  },
  {
    box_no: 'BOX-SAMPLE-002',
    batch_no: 'BATCH-2026-0601-001',
    kitchen_staff: '张厨师',
    meal_items: [
      { name: '宫保鸡丁套餐', quantity: 3, price: 32 },
      { name: '麻婆豆腐套餐', quantity: 2, price: 28 }
    ],
    status: 'DRIVER_RECEIVED',
    current_custodian: '王司机',
    custodian_type: 'DRIVER',
    driver: '王司机'
  },
  {
    box_no: 'BOX-SAMPLE-003',
    batch_no: 'BATCH-2026-0601-002',
    kitchen_staff: '刘厨师',
    meal_items: [
      { name: '糖醋排骨套餐', quantity: 2, price: 42 },
      { name: '时蔬套餐', quantity: 3, price: 22 }
    ],
    status: 'EXCEPTION_ISOLATED',
    current_custodian: '赵质控',
    custodian_type: 'QC',
    driver: '孙司机',
    store_staff: '陈店长',
    is_exception: true,
    exception_reason: '运输途中温度超标，最高达12°C'
  },
  {
    box_no: 'BOX-SAMPLE-004',
    batch_no: 'BATCH-2026-0601-002',
    kitchen_staff: '刘厨师',
    meal_items: [
      { name: '咖喱鸡套餐', quantity: 4, price: 38 }
    ],
    status: 'BOXED',
    current_custodian: '张厨师',
    custodian_type: 'KITCHEN'
  },
  {
    box_no: 'BOX-SAMPLE-005',
    batch_no: 'BATCH-2026-0601-003',
    kitchen_staff: '周厨师',
    meal_items: [
      { name: '牛肉面套餐', quantity: 3, price: 30 },
      { name: '馄饨套餐', quantity: 2, price: 26 }
    ],
    status: 'ARCHIVED',
    current_custodian: '系统',
    custodian_type: 'SYSTEM',
    driver: '孙司机',
    store_staff: '王店长',
    archived_at: moment().subtract(2, 'hours').format('YYYY-MM-DD HH:mm:ss')
  }
];

async function initSampleData() {
  const existing = await get('SELECT id FROM boxes WHERE box_no = ?', ['BOX-SAMPLE-001']);
  if (existing) {
    console.log('样例数据已存在，跳过初始化');
    return false;
  }

  const config = await getActiveConfig();
  const now = moment();

  console.log('开始初始化样例批次数据...');

  for (const sample of SAMPLE_BOXES) {
    await insertSampleBox(sample, config, now);
    console.log(`  已创建样例餐盒: ${sample.box_no}`);
  }

  console.log('样例数据初始化完成');
  return true;
}

async function insertSampleBox(sample, config, baseTime) {
  const now = baseTime.format('YYYY-MM-DD HH:mm:ss');
  const t1 = baseTime.clone().subtract(180, 'minutes').format('YYYY-MM-DD HH:mm:ss');
  const t2 = baseTime.clone().subtract(150, 'minutes').format('YYYY-MM-DD HH:mm:ss');
  const t3 = baseTime.clone().subtract(120, 'minutes').format('YYYY-MM-DD HH:mm:ss');
  const t4 = baseTime.clone().subtract(90, 'minutes').format('YYYY-MM-DD HH:mm:ss');
  const t5 = baseTime.clone().subtract(60, 'minutes').format('YYYY-MM-DD HH:mm:ss');

  await run(
    `INSERT INTO boxes (box_no, batch_no, status, current_custodian, custodian_type, meal_items, rule_version, created_at, updated_at, archived_at, is_exception, exception_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sample.box_no,
      sample.batch_no,
      sample.status,
      sample.current_custodian,
      sample.custodian_type,
      JSON.stringify(sample.meal_items),
      config.version,
      t1,
      sample.archived_at || now,
      sample.archived_at || null,
      sample.is_exception ? 1 : 0,
      sample.exception_reason || null
    ]
  );

  await insertSampleHistory(sample, t1, t2, t3, t4, t5);
  await insertSampleTemperatures(sample, config, t1, t2, t3, t4, t5);
}

async function insertSampleHistory(sample, t1, t2, t3, t4, t5) {
  const history = [
    { from: null, to: 'CREATED', operator: sample.kitchen_staff, type: 'KITCHEN', time: t1, remark: '餐盒建档' },
    { from: 'CREATED', to: 'MEAL_PREPARED', operator: sample.kitchen_staff, type: 'KITCHEN', time: t2, remark: '出餐完成' }
  ];

  if (['BOXED', 'DRIVER_RECEIVED', 'STORE_ACCEPTED', 'EXCEPTION_ISOLATED', 'ARCHIVED'].includes(sample.status)) {
    history.push({ from: 'MEAL_PREPARED', to: 'BOXED', operator: sample.kitchen_staff, type: 'KITCHEN', time: t3, remark: '装箱完成' });
  }

  if (['DRIVER_RECEIVED', 'STORE_ACCEPTED', 'EXCEPTION_ISOLATED', 'ARCHIVED'].includes(sample.status)) {
    history.push({ from: 'BOXED', to: 'DRIVER_RECEIVED', operator: sample.driver, type: 'DRIVER', time: t4, remark: '司机接收' });
  }

  if (sample.status === 'STORE_ACCEPTED' || sample.status === 'ARCHIVED') {
    history.push({ from: 'DRIVER_RECEIVED', to: 'STORE_ACCEPTED', operator: sample.store_staff, type: 'STORE', time: t5, remark: '门店验收通过' });
  }

  if (sample.status === 'EXCEPTION_ISOLATED') {
    history.push({ from: 'DRIVER_RECEIVED', to: 'EXCEPTION_ISOLATED', operator: '赵质控', type: 'QC', time: t5, remark: sample.exception_reason });
  }

  if (sample.status === 'ARCHIVED') {
    history.push({ from: 'STORE_ACCEPTED', to: 'ARCHIVED', operator: '系统', type: 'SYSTEM', time: sample.archived_at, remark: '自动归档' });
  }

  for (const h of history) {
    await run(
      `INSERT INTO status_history (box_no, from_status, to_status, operator, operator_type, timestamp, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sample.box_no, h.from, h.to, h.operator, h.type, h.time, h.remark]
    );
  }
}

async function insertSampleTemperatures(sample, config, t1, t2, t3, t4, t5) {
  const normalTemps = [4.2, 3.8, 5.1, 4.5, 3.9];
  const times = [t1, t2, t3, t4, t5];

  if (sample.status === 'EXCEPTION_ISOLATED') {
    for (let i = 0; i < 3; i++) {
      const temp = i === 2 ? 12.3 : normalTemps[i];
      const isAbnormal = temp < config.temp_min || temp > config.temp_max;
      await run(
        `INSERT INTO temperature_readings (box_no, temperature, timestamp, recorded_by, is_abnormal)
         VALUES (?, ?, ?, ?, ?)`,
        [sample.box_no, temp, times[i], sample.driver || sample.kitchen_staff, isAbnormal ? 1 : 0]
      );
    }
  } else {
    for (let i = 0; i < Math.min(normalTemps.length, 4); i++) {
      await run(
        `INSERT INTO temperature_readings (box_no, temperature, timestamp, recorded_by, is_abnormal)
         VALUES (?, ?, ?, ?, 0)`,
        [sample.box_no, normalTemps[i], times[i], sample.driver || sample.kitchen_staff]
      );
    }
  }
}

module.exports = { initSampleData };
