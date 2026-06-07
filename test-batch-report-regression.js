const axios = require('axios');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, 'data', 'tracking.db');

let testReportNo = null;
let firstSnapshotTime = null;
let firstConfigVersion = null;

async function waitForServer() {
  console.log('等待服务启动...');
  for (let i = 0; i < 30; i++) {
    try {
      await axios.get(`${BASE_URL}/api/health`);
      console.log('服务已就绪');
      return;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('服务启动超时');
}

function logTest(name, passed, details = '') {
  const status = passed ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (details && !passed) {
    console.log(`  ${details}`);
  }
}

async function runTests() {
  console.log('=========================================');
  console.log('  批次复盘报告回归测试');
  console.log('=========================================\n');

  let passedCount = 0;
  let failedCount = 0;
  const failures = [];

  try {
    await waitForServer();

    const testBatchNo = 'BATCH-2026-0601-001';

    console.log('--- 测试 1: QC 角色生成批次复盘报告 ---\n');
    try {
      const res = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'QC'
      });

      assert.strictEqual(res.data.success, true, '响应 success 应为 true');
      assert.ok(res.data.data.report_no, '应包含 report_no');
      assert.ok(res.data.data.report_no.startsWith('BGR'), '报告号应以 BGR 开头');
      assert.strictEqual(res.data.data.batch_no, testBatchNo, '批次号应匹配');
      assert.strictEqual(res.data.data.total_boxes, 2, '该批次应有 2 个餐盒');
      assert.ok(res.data.data.status_summary, '应包含 status_summary');
      assert.ok(res.data.data.handover_timestamps, '应包含 handover_timestamps');
      assert.ok(res.data.data.corrections_summary, '应包含 corrections_summary');
      assert.ok(res.data.data.exported_documents, '应包含 exported_documents');
      assert.ok(res.data.data.snapshot_data, '应包含 snapshot_data');
      assert.ok(res.data.data.config_version, '应包含 config_version');
      assert.ok(res.data.data._meta, '应包含 _meta');
      assert.strictEqual(res.data.data._meta.is_authorized, true, 'QC 角色应授权');
      assert.ok(Array.isArray(res.data.data._meta.visible_fields), '应包含可见字段列表');

      testReportNo = res.data.data.report_no;
      firstSnapshotTime = res.data.data.snapshot_data.snapshot_time;
      firstConfigVersion = res.data.data.config_version;

      logTest('QC 生成报告', true);
      console.log(`  报告号: ${testReportNo}`);
      console.log(`  快照时间: ${firstSnapshotTime}`);
      console.log(`  配置版本: ${firstConfigVersion}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('QC 生成报告', false, err);
      failures.push({ test: 'QC 生成报告', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 2: 报告配置开关 ---\n');
    try {
      const configRes = await axios.get(`${BASE_URL}/api/config`);
      const originalConfig = configRes.data.data;

      await axios.post(`${BASE_URL}/api/config`, {
        operator: '系统管理员',
        version: 'v1.0.0-report-test-disabled',
        temp_min: originalConfig.temp_min,
        temp_max: originalConfig.temp_max,
        delivery_time_limit: originalConfig.delivery_time_limit,
        report_enabled: false,
        acceptance_rules: originalConfig.acceptance_rules
      });

      try {
        await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
          operator: '赵质控',
          operator_type: 'QC'
        });
        logTest('配置关闭时拒绝访问', false, '应返回 403 错误');
        failures.push({ test: '配置关闭时拒绝访问', error: '未拒绝访问' });
        failedCount++;
      } catch (e) {
        assert.strictEqual(e.response.status, 403, '应返回 403');
        assert.ok(e.response.data.error.includes('已关闭'), '错误信息应包含"已关闭"');
        logTest('配置关闭时拒绝访问', true);
        passedCount++;
      }

      await axios.post(`${BASE_URL}/api/config`, {
        operator: '系统管理员',
        version: 'v1.0.0-report-test-restored',
        temp_min: originalConfig.temp_min,
        temp_max: originalConfig.temp_max,
        delivery_time_limit: originalConfig.delivery_time_limit,
        report_enabled: true,
        acceptance_rules: originalConfig.acceptance_rules
      });

      const reEnableRes = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'QC'
      });
      assert.strictEqual(reEnableRes.data.success, true, '重新开启后应可正常生成');
      logTest('配置恢复后可正常生成', true);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('配置开关测试', false, err);
      failures.push({ test: '配置开关测试', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 3: 权限差异 - 非 QC 角色生成报告仅见基础字段 ---\n');
    try {
      const res = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '王司机',
        operator_type: 'DRIVER'
      });

      assert.strictEqual(res.data.success, true, '响应 success 应为 true');
      assert.strictEqual(res.data.data._meta.is_authorized, false, 'DRIVER 角色不应授权');
      assert.ok(res.data.data.batch_no, '应包含 batch_no');
      assert.ok(res.data.data.total_boxes, '应包含 total_boxes');
      assert.ok(res.data.data.status_summary, '应包含 status_summary');
      assert.strictEqual(res.data.data.handover_timestamps, undefined, '不应包含 handover_timestamps');
      assert.strictEqual(res.data.data.temperature_abnormalities, undefined, '不应包含 temperature_abnormalities');
      assert.strictEqual(res.data.data.corrections_summary, undefined, '不应包含 corrections_summary');
      assert.strictEqual(res.data.data.exported_documents, undefined, '不应包含 exported_documents');
      assert.strictEqual(res.data.data.conflict_details, undefined, '不应包含 conflict_details');

      const visibleFields = res.data.data._meta.visible_fields;
      assert.ok(visibleFields.includes('batch_no'), '可见字段应包含 batch_no');
      assert.ok(visibleFields.includes('total_boxes'), '可见字段应包含 total_boxes');
      assert.ok(visibleFields.includes('status_summary'), '可见字段应包含 status_summary');
      assert.ok(!visibleFields.includes('handover_timestamps'), '可见字段不应包含 handover_timestamps');

      logTest('DRIVER 角色仅见基础字段', true);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('权限差异 - DRIVER 生成报告', false, err);
      failures.push({ test: '权限差异 - DRIVER 生成报告', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 4: 权限差异 - 非 QC 访问完整报告被拒 ---\n');
    try {
      await axios.get(`${BASE_URL}/api/reports/${testReportNo}?operator_type=DRIVER`);
      logTest('DRIVER 访问完整报告被拒', false, '应返回 403 错误');
      failures.push({ test: 'DRIVER 访问完整报告被拒', error: '未拒绝访问' });
      failedCount++;
    } catch (e) {
      assert.strictEqual(e.response.status, 403, '应返回 403');
      assert.ok(e.response.data.error.includes('权限不足'), '错误信息应包含"权限不足"');
      assert.ok(e.response.data.error.includes('QC 或管理员'), '错误信息应包含"QC 或管理员"');
      logTest('DRIVER 访问完整报告被拒', true);
      passedCount++;
    }

    console.log('\n--- 测试 5: 权限差异 - QC 访问完整报告成功 ---\n');
    try {
      const res = await axios.get(`${BASE_URL}/api/reports/${testReportNo}?operator_type=QC`);
      assert.strictEqual(res.data.success, true, '响应 success 应为 true');
      assert.ok(res.data.data.handover_timestamps, '应包含 handover_timestamps');
      assert.ok(res.data.data.snapshot_data, '应包含 snapshot_data');
      assert.strictEqual(res.data.data._meta.is_authorized, true, 'QC 角色应授权');
      logTest('QC 访问完整报告成功', true);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('QC 访问完整报告', false, err);
      failures.push({ test: 'QC 访问完整报告', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 6: 权限差异 - ADMIN 访问完整报告成功 ---\n');
    try {
      const res = await axios.get(`${BASE_URL}/api/reports/${testReportNo}?operator_type=ADMIN`);
      assert.strictEqual(res.data.success, true, '响应 success 应为 true');
      assert.ok(res.data.data.handover_timestamps, '应包含 handover_timestamps');
      assert.ok(res.data.data.snapshot_data, '应包含 snapshot_data');
      assert.strictEqual(res.data.data._meta.is_authorized, true, 'ADMIN 角色应授权');
      logTest('ADMIN 访问完整报告成功', true);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('ADMIN 访问完整报告', false, err);
      failures.push({ test: 'ADMIN 访问完整报告', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 7: 基础信息接口 - 任何角色可访问 ---\n');
    try {
      const res = await axios.get(`${BASE_URL}/api/reports/${testReportNo}/basic?operator_type=STORE`);
      assert.strictEqual(res.data.success, true, '响应 success 应为 true');
      assert.ok(res.data.data.batch_no, '应包含 batch_no');
      assert.ok(res.data.data.status_summary, '应包含 status_summary');
      assert.strictEqual(res.data.data._meta.is_authorized, false, 'STORE 角色不应授权');
      logTest('STORE 访问基础信息成功', true);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('基础信息接口', false, err);
      failures.push({ test: '基础信息接口', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 8: 报告列表按角色返回不同字段 ---\n');
    try {
      const qcRes = await axios.get(`${BASE_URL}/api/reports?operator_type=QC&batch_no=${testBatchNo}`);
      assert.strictEqual(qcRes.data.success, true, 'QC 列表查询 success 应为 true');
      assert.ok(qcRes.data.data.length > 0, '应返回报告列表');
      assert.ok(qcRes.data.data[0].handover_timestamps !== undefined, 'QC 可见 handover_timestamps');

      const driverRes = await axios.get(`${BASE_URL}/api/reports?operator_type=DRIVER&batch_no=${testBatchNo}`);
      assert.strictEqual(driverRes.data.success, true, 'DRIVER 列表查询 success 应为 true');
      assert.ok(driverRes.data.data.length > 0, '应返回报告列表');
      assert.strictEqual(driverRes.data.data[0].handover_timestamps, undefined, 'DRIVER 不可见 handover_timestamps');

      logTest('报告列表按角色过滤字段', true);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('报告列表角色过滤', false, err);
      failures.push({ test: '报告列表角色过滤', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 9: 快照不可变性 - 生成更正后旧报告快照不变 ---\n');
    try {
      const boxDetail = await axios.get(`${BASE_URL}/api/boxes/BOX-SAMPLE-001`);
      const tempRecordId = boxDetail.data.data.temperature_readings[0].id;

      await axios.post(`${BASE_URL}/api/corrections`, {
        box_no: 'BOX-SAMPLE-001',
        record_type: 'temperature',
        record_id: tempRecordId,
        field_name: 'temperature',
        proposed_value: '4.8',
        apply_reason: '回归测试：温度读数误差',
        applicant: '王司机',
        applicant_type: 'DRIVER'
      });

      const oldReport = await axios.get(`${BASE_URL}/api/reports/${testReportNo}?operator_type=QC`);
      const oldSnapshotTime = oldReport.data.data.snapshot_data.snapshot_time;
      const oldCorrectionTotal = oldReport.data.data.corrections_summary.total;

      await new Promise(r => setTimeout(r, 1100));

      const newReportRes = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'QC'
      });
      const newReportNo = newReportRes.data.data.report_no;
      const newSnapshotTime = newReportRes.data.data.snapshot_data.snapshot_time;
      const newCorrectionTotal = newReportRes.data.data.corrections_summary.total;

      assert.strictEqual(oldSnapshotTime, firstSnapshotTime, '旧报告快照时间应保持不变');
      assert.strictEqual(oldCorrectionTotal, 0, '旧报告更正总数应保持 0');
      assert.notStrictEqual(newSnapshotTime, firstSnapshotTime, '新报告快照时间应不同');
      assert.strictEqual(newCorrectionTotal, 1, '新报告更正总数应为 1');
      assert.notStrictEqual(newReportNo, testReportNo, '新报告号应不同');

      logTest('快照不可变性验证', true);
      console.log(`  旧报告: ${testReportNo}, 快照时间: ${oldSnapshotTime}, 更正数: ${oldCorrectionTotal}`);
      console.log(`  新报告: ${newReportNo}, 快照时间: ${newSnapshotTime}, 更正数: ${newCorrectionTotal}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('快照不可变性', false, err);
      failures.push({ test: '快照不可变性', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 10: 冲突检测 - 待审更正提示 ---\n');
    try {
      const res = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'QC'
      });

      assert.strictEqual(res.data.data.has_conflicts, true, '应有冲突');
      assert.ok(res.data.data.conflict_warnings.length > 0, '应有冲突警告');
      const pendingWarning = res.data.data.conflict_warnings.find(w => w.type === 'PENDING_CORRECTIONS');
      assert.ok(pendingWarning, '应包含 PENDING_CORRECTIONS 警告');
      assert.strictEqual(pendingWarning.severity, 'WARNING', '严重程度应为 WARNING');
      assert.ok(pendingWarning.message.includes('待审核'), '警告信息应包含"待审核"');
      assert.ok(res.data.message.includes('冲突提示'), '响应消息应包含"冲突提示"');

      assert.ok(res.data.data.conflict_details.length > 0, '应有冲突详情');
      const pendingDetail = res.data.data.conflict_details.find(d => d.type === 'PENDING_CORRECTIONS');
      assert.ok(pendingDetail, '冲突详情应包含 PENDING_CORRECTIONS');
      assert.ok(pendingDetail.details.pending_count > 0, '冲突详情应包含待审数量');
      assert.ok(Array.isArray(pendingDetail.details.pending_corrections), '冲突详情应包含待审更正列表');
      assert.ok(pendingDetail.details.pending_corrections[0].correction_no, '待审更正应包含 correction_no');

      logTest('待审更正冲突检测', true);
      console.log(`  冲突类型: ${pendingWarning.type}`);
      console.log(`  严重程度: ${pendingWarning.severity}`);
      console.log(`  警告信息: ${pendingWarning.message}`);
      console.log(`  待审数量: ${pendingDetail.details.pending_count}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('待审更正冲突检测', false, err);
      failures.push({ test: '待审更正冲突检测', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 11: 冲突检测 - 导出版本不一致提示 ---\n');
    try {
      const exportRes = await axios.post(`${BASE_URL}/api/export/handover/BOX-SAMPLE-001`, {
        operator: '李店长'
      });
      const originalDocNo = exportRes.data.data.doc_no;

      await axios.post(`${BASE_URL}/api/export/${originalDocNo}/reexport`, {
        operator: '赵质控',
        operator_type: 'QC',
        reexport_reason: '回归测试：重新导出验证版本冲突'
      });

      const res = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'QC'
      });

      const versionWarning = res.data.data.conflict_warnings.find(w => w.type === 'EXPORT_VERSION_MISMATCH');
      assert.ok(versionWarning, '应包含 EXPORT_VERSION_MISMATCH 警告');
      assert.strictEqual(versionWarning.severity, 'INFO', '严重程度应为 INFO');
      assert.ok(versionWarning.message.includes('不同版本'), '警告信息应包含"不同版本"');

      const versionDetail = res.data.data.conflict_details.find(d => d.type === 'EXPORT_VERSION_MISMATCH');
      assert.ok(versionDetail, '冲突详情应包含 EXPORT_VERSION_MISMATCH');
      assert.ok(versionDetail.details.mismatched_count > 0, '冲突详情应包含不匹配数量');
      assert.ok(Array.isArray(versionDetail.details.mismatched_groups), '冲突详情应包含不匹配组列表');

      logTest('导出版本不一致冲突检测', true);
      console.log(`  冲突类型: ${versionWarning.type}`);
      console.log(`  严重程度: ${versionWarning.severity}`);
      console.log(`  警告信息: ${versionWarning.message}`);
      console.log(`  不匹配组数: ${versionDetail.details.mismatched_count}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('导出版本不一致冲突检测', false, err);
      failures.push({ test: '导出版本不一致冲突检测', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 12: 审计日志 - 报告生成记录 ---\n');
    try {
      const res = await axios.get(`${BASE_URL}/api/audit-logs?action=BATCH_REPORT_GENERATE`);
      assert.strictEqual(res.data.success, true, 'success 应为 true');
      assert.ok(res.data.data.length > 0, '应有报告生成审计日志');

      const latestLog = res.data.data[0];
      assert.strictEqual(latestLog.action, 'BATCH_REPORT_GENERATE', '操作类型应匹配');
      assert.strictEqual(latestLog.success, 1, '应为成功操作');

      const details = typeof latestLog.details === 'string' ? JSON.parse(latestLog.details) : latestLog.details;
      assert.ok(details.report_no, '详情应包含 report_no');
      assert.ok(details.batch_no, '详情应包含 batch_no');
      assert.ok(details.config_version, '详情应包含 config_version');
      assert.ok('has_conflicts' in details, '详情应包含 has_conflicts');

      logTest('报告生成审计日志', true);
      console.log(`  报告号: ${details.report_no}`);
      console.log(`  批次号: ${details.batch_no}`);
      console.log(`  配置版本: ${details.config_version}`);
      console.log(`  是否冲突: ${details.has_conflicts}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('报告生成审计日志', false, err);
      failures.push({ test: '报告生成审计日志', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 13: 审计日志 - 越权访问记录 ---\n');
    try {
      try {
        await axios.get(`${BASE_URL}/api/reports/${testReportNo}?operator_type=DRIVER`);
      } catch (e) {
      }

      const res = await axios.get(`${BASE_URL}/api/audit-logs?action=BATCH_REPORT_UNAUTHORIZED_ACCESS`);
      assert.strictEqual(res.data.success, true, 'success 应为 true');
      assert.ok(res.data.data.length > 0, '应有越权访问审计日志');

      const latestLog = res.data.data[0];
      assert.strictEqual(latestLog.action, 'BATCH_REPORT_UNAUTHORIZED_ACCESS', '操作类型应匹配');
      assert.strictEqual(latestLog.success, 0, '应为失败操作');
      assert.ok(latestLog.error_message, '应包含错误信息');
      assert.ok(latestLog.error_message.includes('权限不足'), '错误信息应包含"权限不足"');

      const details = typeof latestLog.details === 'string' ? JSON.parse(latestLog.details) : latestLog.details;
      assert.ok(details.report_no, '详情应包含 report_no');
      assert.strictEqual(details.report_no, testReportNo, '报告号应匹配');
      assert.strictEqual(details.operator_type, 'DRIVER', '操作人类型应为 DRIVER');

      logTest('越权访问审计日志', true);
      console.log(`  报告号: ${details.report_no}`);
      console.log(`  操作人类型: ${details.operator_type}`);
      console.log(`  错误信息: ${latestLog.error_message}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('越权访问审计日志', false, err);
      failures.push({ test: '越权访问审计日志', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 14: 配置版本追踪 - 报告记录当时配置 ---\n');
    try {
      const configRes = await axios.get(`${BASE_URL}/api/config`);
      const originalConfig = configRes.data.data;

      await axios.post(`${BASE_URL}/api/config`, {
        operator: '系统管理员',
        version: 'v1.0.0-report-config-test',
        temp_min: 2,
        temp_max: 10,
        delivery_time_limit: 180,
        acceptance_rules: originalConfig.acceptance_rules
      });

      const res = await axios.post(`${BASE_URL}/api/reports/batch/BATCH-2026-0601-002`, {
        operator: '赵质控',
        operator_type: 'QC'
      });

      assert.strictEqual(res.data.data.config_version, 'v1.0.0-report-config-test', '应记录新配置版本');
      assert.strictEqual(res.data.data.snapshot_data.config_snapshot.temp_min, 2, '快照应记录新 temp_min');
      assert.strictEqual(res.data.data.snapshot_data.config_snapshot.temp_max, 10, '快照应记录新 temp_max');
      assert.strictEqual(res.data.data.snapshot_data.config_snapshot.delivery_time_limit, 180, '快照应记录新 delivery_time_limit');

      await axios.post(`${BASE_URL}/api/config`, {
        operator: '系统管理员',
        version: 'v1.0.0-report-config-restored',
        temp_min: originalConfig.temp_min,
        temp_max: originalConfig.temp_max,
        delivery_time_limit: originalConfig.delivery_time_limit,
        acceptance_rules: originalConfig.acceptance_rules
      });

      logTest('配置版本追踪', true);
      console.log(`  报告配置版本: ${res.data.data.config_version}`);
      console.log(`  快照 temp_min: ${res.data.data.snapshot_data.config_snapshot.temp_min}`);
      console.log(`  快照 temp_max: ${res.data.data.snapshot_data.config_snapshot.temp_max}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('配置版本追踪', false, err);
      failures.push({ test: '配置版本追踪', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 15: 可见字段白名单配置 ---\n');
    try {
      const configRes = await axios.get(`${BASE_URL}/api/config`);
      const originalConfig = configRes.data.data;

      await axios.post(`${BASE_URL}/api/config`, {
        operator: '系统管理员',
        version: 'v1.0.0-report-whitelist-test',
        temp_min: originalConfig.temp_min,
        temp_max: originalConfig.temp_max,
        delivery_time_limit: originalConfig.delivery_time_limit,
        report_visible_fields: ['batch_no', 'total_boxes', 'status_summary', 'config_version'],
        acceptance_rules: originalConfig.acceptance_rules
      });

      const res = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'QC'
      });

      const visibleFields = res.data.data._meta.visible_fields;
      assert.deepStrictEqual(visibleFields, ['batch_no', 'total_boxes', 'status_summary', 'config_version'], '可见字段应匹配白名单');
      assert.ok(res.data.data.batch_no, '应包含 batch_no');
      assert.ok(res.data.data.total_boxes, '应包含 total_boxes');
      assert.strictEqual(res.data.data.handover_timestamps, undefined, '不应包含 handover_timestamps');
      assert.strictEqual(res.data.data.corrections_summary, undefined, '不应包含 corrections_summary');

      await axios.post(`${BASE_URL}/api/config`, {
        operator: '系统管理员',
        version: 'v1.0.0-report-whitelist-restored',
        temp_min: originalConfig.temp_min,
        temp_max: originalConfig.temp_max,
        delivery_time_limit: originalConfig.delivery_time_limit,
        acceptance_rules: originalConfig.acceptance_rules
      });

      logTest('可见字段白名单', true);
      console.log(`  白名单字段: ${JSON.stringify(visibleFields)}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('可见字段白名单', false, err);
      failures.push({ test: '可见字段白名单', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 16: 服务重启后数据一致性 - 模拟跨重启读取 ---\n');
    try {
      const beforeRestart = await axios.get(`${BASE_URL}/api/reports/${testReportNo}?operator_type=QC`);
      const beforeContent = JSON.stringify({
        report_no: beforeRestart.data.data.report_no,
        batch_no: beforeRestart.data.data.batch_no,
        config_version: beforeRestart.data.data.config_version,
        snapshot_time: beforeRestart.data.data.snapshot_data.snapshot_time,
        total_boxes: beforeRestart.data.data.total_boxes,
        status_summary: beforeRestart.data.data.status_summary
      });

      assert.ok(fs.existsSync(DB_PATH), '数据库文件应存在');
      console.log(`  数据库路径: ${DB_PATH}`);
      console.log(`  数据库大小: ${fs.statSync(DB_PATH).size} bytes`);

      const listBefore = await axios.get(`${BASE_URL}/api/reports?operator_type=QC`);
      const reportCountBefore = listBefore.data.data.length;

      console.log(`  重启前报告数量: ${reportCountBefore}`);
      console.log(`  首份报告号: ${testReportNo}`);
      console.log(`  首份快照时间: ${firstSnapshotTime}`);
      console.log(`  首份配置版本: ${firstConfigVersion}`);

      const auditRes = await axios.get(`${BASE_URL}/api/audit-logs?action=BATCH_REPORT_GENERATE`);
      const logCount = auditRes.data.data.length;
      console.log(`  报告生成审计日志数量: ${logCount}`);

      const firstReport = listBefore.data.data.find(r => r.report_no === testReportNo);
      assert.ok(firstReport, '重启前应能找到首份报告');
      assert.strictEqual(firstReport.config_version, firstConfigVersion, '配置版本应一致');

      logTest('跨重启数据准备（数据已持久化到数据库）', true);
      console.log('  注意：完整的重启测试需要手动重启服务后运行 test-export-restart-verify.js');
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('跨重启数据一致性', false, err);
      failures.push({ test: '跨重启数据一致性', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 17: 报告内容完整性验证 ---\n');
    try {
      const res = await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'QC'
      });

      const data = res.data.data;

      assert.ok(data.status_summary.STORE_ACCEPTED !== undefined, '状态汇总应包含 STORE_ACCEPTED');
      assert.ok(data.status_summary.STORE_ACCEPTED_label, '状态汇总应包含 label');
      assert.ok(data.handover_timestamps.CREATED, '交接时间应包含 CREATED');
      assert.ok(data.handover_timestamps.CREATED.earliest, '交接时间应包含 earliest');
      assert.ok(data.handover_timestamps.CREATED.latest, '交接时间应包含 latest');
      assert.ok(data.handover_timestamps.CREATED.count > 0, '交接时间应包含 count');
      assert.ok(Array.isArray(data.temperature_abnormalities), '温度异常应为数组');
      assert.ok(Array.isArray(data.isolation_reasons), '隔离原因应为数组');
      assert.ok(Array.isArray(data.exported_documents), '导出单据应为数组');
      assert.ok(data.exported_documents[0]?.doc_type_label, '导出单据应包含类型标签');
      assert.ok(data.corrections_summary.total !== undefined, '更正汇总应包含总数');
      assert.ok(data.snapshot_data.boxes.length === data.total_boxes, '快照餐盒数量应匹配');
      assert.ok(data.snapshot_data.config_snapshot, '快照应包含配置快照');
      assert.strictEqual(data.snapshot_data.config_version, data.config_version, '配置版本应一致');

      logTest('报告内容完整性', true);
      console.log(`  状态汇总: STORE_ACCEPTED=${data.status_summary.STORE_ACCEPTED}`);
      console.log(`  交接时间节点数: ${Object.keys(data.handover_timestamps).length}`);
      console.log(`  温度异常数: ${data.temperature_abnormalities.length}`);
      console.log(`  导出单据数: ${data.exported_documents.length}`);
      console.log(`  更正总数: ${data.corrections_summary.total}`);
      console.log(`  快照餐盒数: ${data.snapshot_data.boxes.length}`);
      passedCount++;
    } catch (e) {
      const err = e.response?.data?.error || e.message;
      logTest('报告内容完整性', false, err);
      failures.push({ test: '报告内容完整性', error: err });
      failedCount++;
    }

    console.log('\n--- 测试 18: 不存在的批次返回 404 ---\n');
    try {
      await axios.post(`${BASE_URL}/api/reports/batch/NONEXISTENT-BATCH`, {
        operator: '赵质控',
        operator_type: 'QC'
      });
      logTest('不存在的批次返回 404', false, '应返回 404 错误');
      failures.push({ test: '不存在的批次返回 404', error: '未返回 404' });
      failedCount++;
    } catch (e) {
      assert.strictEqual(e.response.status, 404, '应返回 404');
      assert.ok(e.response.data.error.includes('不存在'), '错误信息应包含"不存在"');
      logTest('不存在的批次返回 404', true);
      passedCount++;
    }

    console.log('\n--- 测试 19: 参数验证 - 缺少 operator ---\n');
    try {
      await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator_type: 'QC'
      });
      logTest('缺少 operator 验证', false, '应返回 400 错误');
      failures.push({ test: '缺少 operator 验证', error: '未返回 400' });
      failedCount++;
    } catch (e) {
      assert.strictEqual(e.response.status, 400, '应返回 400');
      assert.ok(e.response.data.error.includes('参数验证失败'), '错误信息应包含"参数验证失败"');
      logTest('缺少 operator 验证', true);
      passedCount++;
    }

    console.log('\n--- 测试 20: 参数验证 - 无效 operator_type ---\n');
    try {
      await axios.post(`${BASE_URL}/api/reports/batch/${testBatchNo}`, {
        operator: '赵质控',
        operator_type: 'INVALID'
      });
      logTest('无效 operator_type 验证', false, '应返回 400 错误');
      failures.push({ test: '无效 operator_type 验证', error: '未返回 400' });
      failedCount++;
    } catch (e) {
      assert.strictEqual(e.response.status, 400, '应返回 400');
      assert.ok(e.response.data.error.includes('参数验证失败'), '错误信息应包含"参数验证失败"');
      logTest('无效 operator_type 验证', true);
      passedCount++;
    }

  } catch (e) {
    console.error('测试执行失败:', e);
    failedCount++;
    failures.push({ test: '整体测试执行', error: e.message });
  }

  console.log('\n=========================================');
  console.log('  测试结果汇总');
  console.log('=========================================');
  console.log(`通过: ${passedCount}`);
  console.log(`失败: ${failedCount}`);
  console.log(`总计: ${passedCount + failedCount}`);
  console.log(`通过率: ${((passedCount / (passedCount + failedCount)) * 100).toFixed(1)}%`);

  if (failures.length > 0) {
    console.log('\n失败详情:');
    for (const f of failures) {
      console.log(`  - ${f.test}: ${f.error}`);
    }
  }

  if (failedCount > 0) {
    process.exit(1);
  } else {
    console.log('\n✓ 所有测试通过！');
    process.exit(0);
  }
}

runTests();
