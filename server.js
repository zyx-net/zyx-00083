const express = require('express');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const apiRoutes = require('./src/routes/api');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const { initConfig, getActiveConfig } = require('./src/config/configManager');
const { initSampleData } = require('./src/data/sampleData');
const { initDatabase } = require('./src/database/init');
const { expireOverdueCorrections } = require('./src/business/correctionService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', apiRoutes);

app.get('/', (req, res) => {
  res.json({
    name: '冷链餐盒交付追踪 API',
    version: '1.0.0',
    docs: '/API_DOCS.md',
    health: '/api/health',
    endpoints: {
      config: '/api/config',
      boxes: '/api/boxes',
      temperature: '/api/temperature',
      audit_logs: '/api/audit-logs',
      exceptions: '/api/exceptions',
      export: '/api/export/handover/:box_no',
      reports: '/api/reports/batch/:batch_no',
      meta: '/api/meta/statuses'
    }
  });
});

app.get('/API_DOCS.md', (req, res) => {
  res.sendFile(path.join(__dirname, 'API_DOCS.md'));
});

app.use(errorHandler);
app.use(notFoundHandler);

async function startServer() {
  try {
    await initDatabase();
    await initConfig();
    await initSampleData();
    
    const expiredCount = await expireOverdueCorrections();
    if (expiredCount > 0) {
      console.log(`已自动标记 ${expiredCount} 条超时未审核的更正申请为已过期`);
    }
    
    const activeConfig = await getActiveConfig();
    
    app.listen(PORT, () => {
      console.log('=========================================');
      console.log('   冷链餐盒交付追踪 API 服务已启动');
      console.log('=========================================');
      console.log(`服务地址: http://localhost:${PORT}`);
      console.log(`健康检查: http://localhost:${PORT}/api/health`);
      console.log(`API 文档: http://localhost:${PORT}/API_DOCS.md`);
      console.log('=========================================');
      console.log('内置样例数据:');
      console.log('  BOX-SAMPLE-001 (已验收)');
      console.log('  BOX-SAMPLE-002 (配送中)');
      console.log('  BOX-SAMPLE-003 (异常隔离)');
      console.log('  BOX-SAMPLE-004 (已装箱)');
      console.log('  BOX-SAMPLE-005 (已归档)');
      console.log('=========================================');
      console.log('更正功能已启用:');
      console.log('  - 可更正字段: current_custodian, temperature, timestamp, operator, custodian_type');
      console.log('  - 默认审核时限: 24小时');
      console.log('  - 审核角色: QC (质控)');
      console.log('=========================================');
      console.log('导出更正追溯能力:');
      console.log('  - 交接单/异常清单导出自动保存更正快照');
      console.log('  - 快照包含: 状态、过期标记、冲突数量、审核人、审核原因');
      console.log('  - 历史单据快照永久保存，不会被后续更正改写');
      console.log('  - 服务重启后快照保持一致');
      console.log('  - 重新导出功能: ' + (activeConfig.allow_reexport ? '已开启 (默认)' : '已关闭'));
    console.log('  - 重新导出权限: 仅 QC 可操作');
    console.log('=========================================');
    console.log('批次复盘报告能力:');
    console.log('  - 报告功能: ' + (activeConfig.report_enabled ? '已开启 (默认)' : '已关闭'));
    console.log('  - 可见字段白名单: ' + (activeConfig.report_visible_fields?.length || 0) + ' 个字段');
    console.log('  - 快照存储: 每次生成报告自动保存数据快照');
    console.log('  - 权限控制: 非 QC/管理员仅可查看基础字段');
    console.log('  - 冲突检测: 待审更正、导出版本不一致自动提示');
    console.log('=========================================');
  });
  } catch (err) {
    console.error('服务启动失败:', err);
    process.exit(1);
  }
}

startServer();
