const express = require('express');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const apiRoutes = require('./src/routes/api');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const { initConfig } = require('./src/config/configManager');
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
    });
  } catch (err) {
    console.error('服务启动失败:', err);
    process.exit(1);
  }
}

startServer();
