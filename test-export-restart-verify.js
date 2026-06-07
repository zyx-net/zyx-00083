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

async function verifyRestart() {
  console.log('========================================');
  console.log('  服务重启后快照验证');
  console.log('========================================\n');

  const args = process.argv.slice(2);
  const DOC_NO = args[0];
  const EXPECTED_SNAPSHOT_TIME = args[1];
  const EXPECTED_TOTAL = parseInt(args[2]) || 0;
  const EXPECTED_APPROVED = parseInt(args[3]) || 0;
  const EXPECTED_PENDING = parseInt(args[4]) || 0;

  if (!DOC_NO) {
    console.log('用法: node test-export-restart-verify.js <单据号> [期望快照时间] [期望更正总数] [期望已通过数] [期望待审核数]');
    console.log('示例: node test-export-restart-verify.js HJD202606071234 "2026-06-07 14:30:00" 1 1 0');
    process.exit(1);
  }

  try {
    console.log(`验证单据: ${DOC_NO}`);
    console.log(`期望快照时间: ${EXPECTED_SNAPSHOT_TIME || '不校验'}`);
    console.log(`期望更正总数: ${EXPECTED_TOTAL}`);
    console.log(`期望已通过数: ${EXPECTED_APPROVED}`);
    console.log(`期望待审核数: ${EXPECTED_PENDING}`);
    console.log();

    const resp = await axios.get(`${BASE_URL}/export/${DOC_NO}`);
    if (!resp.data.success) {
      throw new Error(`查询失败: ${resp.data.error}`);
    }

    const doc = resp.data.data;
    const snapshot = doc.correction_snapshot;

    if (!snapshot) {
      throw new Error('单据未包含更正快照');
    }
    logPass('✓ 单据存在，且包含更正快照');

    if (EXPECTED_SNAPSHOT_TIME && snapshot.snapshot_time !== EXPECTED_SNAPSHOT_TIME) {
      throw new Error(`快照时间不匹配！期望: ${EXPECTED_SNAPSHOT_TIME}, 实际: ${snapshot.snapshot_time}`);
    }
    logPass(`✓ 快照时间正确: ${snapshot.snapshot_time}`);

    if (snapshot.overall.total_corrections !== EXPECTED_TOTAL) {
      throw new Error(`更正总数不匹配！期望: ${EXPECTED_TOTAL}, 实际: ${snapshot.overall.total_corrections}`);
    }
    logPass(`✓ 更正总数正确: ${snapshot.overall.total_corrections}`);

    if (snapshot.overall.approved_count !== EXPECTED_APPROVED) {
      throw new Error(`已通过数量不匹配！期望: ${EXPECTED_APPROVED}, 实际: ${snapshot.overall.approved_count}`);
    }
    logPass(`✓ 已通过数量正确: ${snapshot.overall.approved_count}`);

    if (snapshot.overall.pending_count !== EXPECTED_PENDING) {
      throw new Error(`待审核数量不匹配！期望: ${EXPECTED_PENDING}, 实际: ${snapshot.overall.pending_count}`);
    }
    logPass(`✓ 待审核数量正确: ${snapshot.overall.pending_count}`);

    if (snapshot.overall.expired_count !== undefined) {
      logPass(`✓ 已过期数量: ${snapshot.overall.expired_count}`);
    }
    if (snapshot.overall.conflict_count !== undefined) {
      logPass(`✓ 冲突数量: ${snapshot.overall.conflict_count}`);
    }

    if (doc.is_reexport !== undefined) {
      logPass(`✓ 是否重新导出: ${doc.is_reexport ? '是' : '否'}`);
    }
    if (doc.version !== undefined) {
      logPass(`✓ 版本号: ${doc.version}`);
    }
    if (doc.parent_doc_no) {
      logPass(`✓ 父单据号: ${doc.parent_doc_no}`);
    }

    const batchKeys = Object.keys(snapshot.batch_summaries);
    for (const batchKey of batchKeys) {
      const batch = snapshot.batch_summaries[batchKey];
      console.log(`\n批次 ${batchKey} 详情:`);
      console.log(`  总更正数: ${batch.total_corrections}`);
      console.log(`  待审核: ${batch.pending_count}`);
      console.log(`  已通过: ${batch.approved_count}`);
      console.log(`  已驳回: ${batch.rejected_count}`);
      console.log(`  已过期: ${batch.expired_count}`);
      console.log(`  冲突数: ${batch.conflict_count}`);
      if (batch.latest_reviewer) {
        console.log(`  最近审核人: ${batch.latest_reviewer}`);
        console.log(`  最近审核结果: ${batch.latest_review_result}`);
        console.log(`  最近审核原因: ${batch.latest_review_reason}`);
        console.log(`  最近审核时间: ${batch.latest_reviewed_at}`);
      }
      if (batch.corrections && batch.corrections.length > 0) {
        console.log(`  更正明细:`);
        for (const corr of batch.corrections.slice(0, 3)) {
          console.log(`    - ${corr.correction_no}: ${corr.field_name} [${corr.status_label}]`);
          if (corr.reviewer) {
            console.log(`      审核人: ${corr.reviewer}, 原因: ${corr.review_reason}`);
          }
        }
        if (batch.corrections.length > 3) {
          console.log(`    ... 还有 ${batch.corrections.length - 3} 条更正记录`);
        }
      }
    }

    console.log('\n========================================');
    console.log('  ✓ 重启后快照验证通过！');
    console.log('  ✓ 快照数据持久化正常，未被改写');
    console.log('========================================');

  } catch (error) {
    logFail('重启后验证失败', error);
  }
}

verifyRestart();
