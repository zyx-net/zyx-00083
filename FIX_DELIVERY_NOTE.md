# 配置初始化修复 - 交付说明

## 问题描述

当数据库 `configurations` 表中已有 `v1.0.0` 版本记录但所有记录的 `is_active = 0` 时，服务重启会崩溃：

1. `initConfig()` 仅检查 `WHERE is_active = 1` 的记录，返回 `null`
2. 尝试再次插入 `v1.0.0`，触发 `version` 字段的 `UNIQUE` 约束
3. 服务启动流程捕获错误后执行 `process.exit(1)`
4. 所有接口（导出详情、历史快照、重新导出等）全部不可用

## 根因分析

**触发条件**：
- 数据库中存在配置记录（特别是 `v1.0.0`）
- 所有配置记录的 `is_active` 都为 `0`
- 可能场景：之前通过 `addNewConfig` 更新过配置，旧版本被置为非活跃，但新版本被意外删除

**崩溃链路**：
```
[server.js:57-59] initDatabase() → initConfig()
  ↓
[configManager.js:22] SELECT * FROM configurations WHERE is_active = 1 → null
  ↓
[configManager.js:24-38] INSERT INTO configurations (version='v1.0.0', ...)
  ↓
SQLite: UNIQUE constraint failed: configurations.version
  ↓
[server.js:97-100] catch(err) → process.exit(1)
```

## 修复方案

**修改文件**：[src/config/configManager.js](file:///d:/workSpace/AI__SPACE/zyx-00083/src/config/configManager.js#L21-L58)

**修复逻辑（最小改动，4 层降级策略）**：

```
1. 有 active 配置 → 直接使用（原逻辑）
   ↓ 无
2. 有 v1.0.0 配置 → 恢复 v1.0.0 为 active（保留原有配置值）
   ↓ 无
3. 有其他版本配置 → 恢复最新创建的配置为 active
   ↓ 无
4. 完全无配置 → 插入默认 v1.0.0（原逻辑）
```

**关键特性**：
- ✅ 不改动数据库表结构
- ✅ 不改动导出业务逻辑
- ✅ 不换时间戳版本绕过问题
- ✅ 保留原有配置值（包括 `allow_reexport`）
- ✅ 优先恢复 `v1.0.0`（默认版本稳定性优先）

## 代码变更

### 修改文件

| 文件 | 修改说明 |
|------|---------|
| [src/config/configManager.js](file:///d:/workSpace/AI__SPACE/zyx-00083/src/config/configManager.js) | 重写 `initConfig()` 函数，增加 3 层降级恢复逻辑 |

### 新增测试文件

| 文件 | 说明 |
|------|------|
| [test-config-init-reproduce.js](file:///d:/workSpace/AI__SPACE/zyx-00083/test-config-init-reproduce.js) | 问题复现脚本，准备 "有 v1.0.0 但无 active" 的数据库场景 |
| [test-config-init-fix-verify.js](file:///d:/workSpace/AI__SPACE/zyx-00083/test-config-init-fix-verify.js) | 单元测试，7 个场景验证修复逻辑 |
| [test-config-init-regression.py](file:///d:/workSpace/AI__SPACE/zyx-00083/test-config-init-regression.py) | 端到端回归测试，15 个场景覆盖用户可见链路 |

## 验证结果

### 1. 单元测试（7/7 通过）

```
node test-config-init-fix-verify.js
```

| 场景 | 结果 |
|------|------|
| 有 v1.0.0 但无 active，自动恢复 | ✅ PASS |
| 无 v1.0.0 但有其他版本，恢复最新 | ✅ PASS |
| 有 v1.0.0 和其他版本，优先恢复 v1.0.0 | ✅ PASS |
| 完全无配置记录，插入默认 | ✅ PASS |
| 已有 active 配置，保持不变 | ✅ PASS |
| getActiveConfig 递归恢复能力 | ✅ PASS |
| 恢复 v1.0.0 时保留 allow_reexport 原值 | ✅ PASS |

### 2. 端到端回归测试（15/15 通过）

```
python test-config-init-regression.py
```

| 部分 | 场景 | 结果 |
|------|------|------|
| **第一部分**<br>无 active 重启成功 | 1. 准备数据库 (v1.0.0, is_active=0) | ✅ PASS |
| | 2. 启动服务，验证不崩溃 | ✅ PASS |
| | 3. 健康检查和配置接口 | ✅ PASS |
| **第二部分**<br>导出功能验证 | 4. 导出交接单 | ✅ PASS |
| | 5. 导出异常清单 | ✅ PASS |
| | 6. 导出详情接口 | ✅ PASS |
| | 7. 导出历史接口 | ✅ PASS |
| | 8. QC 重新导出成功 | ✅ PASS |
| | 9. 新单据详情 | ✅ PASS |
| | 10. 审计日志 | ✅ PASS |
| | 11. 非 QC 角色重新导出被拒 | ✅ PASS |
| **第三部分**<br>配置开关验证 | 12. 更新配置关闭重新导出 | ✅ PASS |
| | 13. 验证配置生效 | ✅ PASS |
| | 14. QC 重新导出被拒 (配置关闭) | ✅ PASS |
| | 15. 导出详情和历史仍可读 | ✅ PASS |

## 手动验证命令

### 快速验证修复

```bash
# 1. 准备问题场景数据库
node test-config-init-reproduce.js

# 2. 启动服务（修复前此处会崩溃）
npm start

# 预期输出包含：
#   已恢复默认配置为活动状态，版本: v1.0.0

# 3. 验证接口
curl -s http://localhost:3000/api/health | python -m json.tool
curl -s http://localhost:3000/api/config | python -m json.tool
curl -s http://localhost:3000/api/export/HJD202606071234 | python -m json.tool
```

### 完整回归测试

```bash
# Node.js 单元测试
node test-config-init-fix-verify.js

# Python 端到端测试
python test-config-init-regression.py
```

## 影响评估

### 修复影响范围
- **仅修改**：`initConfig()` 函数的初始化逻辑
- **不涉及**：数据库表结构、导出业务逻辑、API 接口定义
- **向后兼容**：100% 兼容现有数据和接口

### 行为变化

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 有 active 配置 | 正常 | 正常（无变化） |
| 完全无配置 | 插入默认 v1.0.0 | 插入默认 v1.0.0（无变化） |
| 有 v1.0.0 但非 active | 💥 崩溃（UNIQUE 约束） | ✅ 自动恢复 v1.0.0 为 active |
| 有其他版本但非 active | 💥 崩溃（UNIQUE 约束） | ✅ 自动恢复最新版本为 active |
| 多个版本都非 active | 💥 崩溃 | ✅ 优先恢复 v1.0.0，其次最新版本 |

### 配置值保留
- 恢复配置时仅更新 `is_active = 1`，不修改任何其他字段
- 原有 `allow_reexport`、`temp_min`、`temp_max` 等配置值完整保留
- 不会因为恢复操作改变任何业务配置

## 风险评估

✅ **无破坏性改动**：仅执行 UPDATE 或 INSERT，不会删除或修改现有配置值

✅ **幂等性**：重复初始化不会造成数据问题

✅ **故障安全**：即使恢复逻辑有缺陷，最坏情况是进入最后一层（插入默认配置），不会导致数据丢失

✅ **可观测**：启动日志明确显示恢复动作：
  - `当前活动配置版本: v1.0.0`（原逻辑）
  - `已恢复默认配置为活动状态，版本: v1.0.0`（新增）
  - `已恢复最新配置为活动状态，版本: v1.1.0`（新增）
  - `默认配置已加载，版本: v1.0.0`（原逻辑）

## 回滚方案

如需回滚，只需恢复 [src/config/configManager.js](file:///d:/workSpace/AI__SPACE/zyx-00083/src/config/configManager.js) 中 `initConfig()` 函数的原始实现（约 22 行代码）。

---

**交付日期**：2026-06-07  
**测试覆盖率**：单元测试 7/7，端到端测试 15/15  
**诊断检查**：无代码错误  
**风险等级**：低（最小改动，仅影响初始化流程）
