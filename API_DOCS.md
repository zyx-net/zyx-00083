# 冷链餐盒交付追踪 API

## 概述

本API用于管理团餐餐盒从**出餐 → 装箱 → 司机接收 → 门店验收 → 异常隔离 → 归档**的全流程追踪。服务基于SQLite持久化存储，重启后所有数据保持一致。

## 快速开始

```bash
npm install
npm start
```

服务默认运行在 `http://localhost:3000`

## 核心概念

### 状态流转

| 状态码 | 状态名称 | 允许流转到 |
|--------|----------|------------|
| CREATED | 已建档 | MEAL_PREPARED |
| MEAL_PREPARED | 已出餐 | BOXED |
| BOXED | 已装箱 | DRIVER_RECEIVED |
| DRIVER_RECEIVED | 司机已接收 | STORE_ACCEPTED, EXCEPTION_ISOLATED |
| STORE_ACCEPTED | 门店已验收 | ARCHIVED |
| EXCEPTION_ISOLATED | 异常已隔离 | ARCHIVED |
| ARCHIVED | 已归档 | - |

### 保管人类型

| 类型码 | 名称 |
|--------|------|
| KITCHEN | 厨房 |
| DRIVER | 司机 |
| STORE | 门店 |
| QC | 质控 |
| SYSTEM | 系统 |

### 配置参数

- **温控阈值**: 默认 0°C ~ 8°C
- **配送时限**: 默认 120 分钟
- **验收规则**: 必须检查温度、必须提供时间戳、必须验证保管人

---

## 一、健康检查

```bash
curl http://localhost:3000/api/health
```

**响应:**
```json
{
  "success": true,
  "data": {
    "status": "running",
    "timestamp": "2026-06-07T...",
    "service": "cold-chain-meal-tracking-api",
    "version": "1.0.0"
  }
}
```

---

## 二、配置管理

### 2.1 获取当前活动配置

```bash
curl http://localhost:3000/api/config
```

### 2.2 获取所有历史配置

```bash
curl http://localhost:3000/api/configs
```

### 2.3 更新配置（生成新版本）

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "系统管理员",
    "version": "v1.0.1",
    "temp_min": 0,
    "temp_max": 10,
    "delivery_time_limit": 180,
    "acceptance_rules": {
      "require_temperature_check": true,
      "require_timestamp": true,
      "max_acceptable_temp_deviation": 2,
      "require_custodian_verification": true,
      "allow_partial_acceptance": false
    }
  }'
```

---

## 三、餐盒管理

### 3.1 餐盒建档

```bash
curl -X POST http://localhost:3000/api/boxes \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-TEST-001",
    "batch_no": "BATCH-2026-0607-001",
    "kitchen_staff": "张厨师",
    "meal_items": [
      {"name": "红烧肉套餐", "quantity": 2, "price": 35},
      {"name": "清蒸鱼套餐", "quantity": 2, "price": 45},
      {"name": "番茄炒蛋套餐", "quantity": 1, "price": 25}
    ]
  }'
```

### 3.2 查询餐盒列表

```bash
# 全部餐盒
curl http://localhost:3000/api/boxes

# 按状态筛选
curl "http://localhost:3000/api/boxes?status=DRIVER_RECEIVED"

# 按批次筛选
curl "http://localhost:3000/api/boxes?batch_no=BATCH-2026-0607-001"

# 仅异常餐盒
curl "http://localhost:3000/api/boxes?is_exception=true"
```

### 3.3 查询餐盒详情

```bash
curl http://localhost:3000/api/boxes/BOX-TEST-001
```

---

## 四、状态流转

### 4.1 出餐 (CREATED → MEAL_PREPARED)

```bash
curl -X PUT http://localhost:3000/api/boxes/BOX-TEST-001/status/MEAL_PREPARED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "张厨师",
    "operator_type": "KITCHEN",
    "remark": "餐品制作完成，检查合格"
  }'
```

### 4.2 装箱 (MEAL_PREPARED → BOXED)

```bash
curl -X PUT http://localhost:3000/api/boxes/BOX-TEST-001/status/BOXED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "张厨师",
    "operator_type": "KITCHEN",
    "remark": "已装入冷链箱，封条完好"
  }'
```

### 4.3 司机接收 (BOXED → DRIVER_RECEIVED)

```bash
curl -X PUT http://localhost:3000/api/boxes/BOX-TEST-001/status/DRIVER_RECEIVED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "张厨师",
    "operator_type": "KITCHEN",
    "new_custodian": "王司机",
    "new_custodian_type": "DRIVER",
    "temperature": 4.5,
    "remark": "交接给司机王师傅"
  }'
```

### 4.4 门店验收 (DRIVER_RECEIVED → STORE_ACCEPTED)

```bash
curl -X PUT http://localhost:3000/api/boxes/BOX-TEST-001/status/STORE_ACCEPTED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "王司机",
    "operator_type": "DRIVER",
    "new_custodian": "李店长",
    "new_custodian_type": "STORE",
    "temperature": 5.2,
    "timestamp": "2026-06-07 12:30:00",
    "remark": "门店验收通过，温度正常"
  }'
```

### 4.5 异常隔离 (DRIVER_RECEIVED → EXCEPTION_ISOLATED)

```bash
curl -X PUT http://localhost:3000/api/boxes/BOX-TEST-002/status/EXCEPTION_ISOLATED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "王司机",
    "operator_type": "DRIVER",
    "new_custodian": "赵质控",
    "new_custodian_type": "QC",
    "exception_reason": "运输途中温度超标，多次检测超过10°C",
    "remark": "异常隔离处理"
  }'
```

### 4.6 归档 (STORE_ACCEPTED/EXCEPTION_ISOLATED → ARCHIVED)

```bash
# 正常验收后归档
curl -X PUT http://localhost:3000/api/boxes/BOX-TEST-001/status/ARCHIVED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "李店长",
    "operator_type": "STORE",
    "new_custodian": "系统",
    "new_custodian_type": "SYSTEM",
    "remark": "订单完成，自动归档"
  }'

# 异常隔离后归档
curl -X PUT http://localhost:3000/api/boxes/BOX-TEST-002/status/ARCHIVED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "赵质控",
    "operator_type": "QC",
    "new_custodian": "系统",
    "new_custodian_type": "SYSTEM",
    "remark": "异常处理完成，归档"
  }'
```

---

## 五、温度上报

```bash
curl -X POST http://localhost:3000/api/temperature \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-TEST-001",
    "temperature": 4.8,
    "timestamp": "2026-06-07 12:15:00",
    "recorded_by": "王司机"
  }'
```

---

## 六、审计日志

```bash
# 全部日志
curl http://localhost:3000/api/audit-logs

# 指定箱号的日志
curl "http://localhost:3000/api/audit-logs?box_no=BOX-TEST-001"

# 指定操作类型
curl "http://localhost:3000/api/audit-logs?action=STATUS_STORE_ACCEPTED"
```

---

## 七、异常清单

```bash
curl http://localhost:3000/api/exceptions
```

---

## 八、导出功能

### 8.1 导出交接单

```bash
curl -X POST http://localhost:3000/api/export/handover/BOX-TEST-001 \
  -H "Content-Type: application/json" \
  -d '{"operator": "李店长"}'
```

### 8.2 导出异常清单

```bash
curl -X POST http://localhost:3000/api/export/exceptions \
  -H "Content-Type: application/json" \
  -d '{"operator": "赵质控"}'
```

### 8.3 查询导出单据

```bash
curl http://localhost:3000/api/export/HJD202606071234
```

### 8.4 查询导出历史

```bash
curl http://localhost:3000/api/export-history
```

---

## 九、元数据

### 9.1 状态列表

```bash
curl http://localhost:3000/api/meta/statuses
```

### 9.2 保管人类型列表

```bash
curl http://localhost:3000/api/meta/custodian-types
```

---

## 十、完整验收主链路示例（可复制执行）

```bash
#!/bin/bash

# 1. 建档
curl -X POST http://localhost:3000/api/boxes \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-MAIN-001",
    "batch_no": "BATCH-MAIN-001",
    "kitchen_staff": "李厨师",
    "meal_items": [
      {"name": "红烧肉套餐", "quantity": 3, "price": 35},
      {"name": "时蔬套餐", "quantity": 2, "price": 22}
    ]
  }'

echo -e "\n---\n"

# 2. 出餐
curl -X PUT http://localhost:3000/api/boxes/BOX-MAIN-001/status/MEAL_PREPARED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "李厨师",
    "operator_type": "KITCHEN",
    "remark": "餐品制作完成"
  }'

echo -e "\n---\n"

# 3. 装箱
curl -X PUT http://localhost:3000/api/boxes/BOX-MAIN-001/status/BOXED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "李厨师",
    "operator_type": "KITCHEN",
    "remark": "装箱完成，封条编号SEA-2026-0001"
  }'

echo -e "\n---\n"

# 4. 司机接收
curl -X PUT http://localhost:3000/api/boxes/BOX-MAIN-001/status/DRIVER_RECEIVED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "李厨师",
    "operator_type": "KITCHEN",
    "new_custodian": "张司机",
    "new_custodian_type": "DRIVER",
    "temperature": 4.2,
    "remark": "厨房交接给司机"
  }'

echo -e "\n---\n"

# 5. 运输途中温度上报
curl -X POST http://localhost:3000/api/temperature \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-MAIN-001",
    "temperature": 5.1,
    "timestamp": "2026-06-07 13:30:00",
    "recorded_by": "张司机"
  }'

echo -e "\n---\n"

# 6. 门店验收
curl -X PUT http://localhost:3000/api/boxes/BOX-MAIN-001/status/STORE_ACCEPTED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "张司机",
    "operator_type": "DRIVER",
    "new_custodian": "王店长",
    "new_custodian_type": "STORE",
    "temperature": 4.9,
    "timestamp": "2026-06-07 14:00:00",
    "remark": "门店验收通过，餐品完好"
  }'

echo -e "\n---\n"

# 7. 归档
curl -X PUT http://localhost:3000/api/boxes/BOX-MAIN-001/status/ARCHIVED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "王店长",
    "operator_type": "STORE",
    "new_custodian": "系统",
    "new_custodian_type": "SYSTEM",
    "remark": "订单完成归档"
  }'

echo -e "\n---\n"

# 8. 导出交接单
curl -X POST http://localhost:3000/api/export/handover/BOX-MAIN-001 \
  -H "Content-Type: application/json" \
  -d '{"operator": "王店长"}'

echo -e "\n---\n"

# 9. 查看最终详情
curl http://localhost:3000/api/boxes/BOX-MAIN-001
```

---

## 十一、错误场景测试

### 11.1 重复箱号建档

```bash
# 首次建档成功
curl -X POST http://localhost:3000/api/boxes \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-DUP-001",
    "batch_no": "BATCH-TEST",
    "kitchen_staff": "李厨师",
    "meal_items": [{"name": "测试套餐", "quantity": 1}]
  }'

# 重复建档失败
curl -X POST http://localhost:3000/api/boxes \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-DUP-001",
    "batch_no": "BATCH-TEST",
    "kitchen_staff": "李厨师",
    "meal_items": [{"name": "测试套餐", "quantity": 1}]
  }'
```

### 11.2 非当前保管人交接

```bash
# 司机接收后，当前保管人是张司机
# 尝试用李厨师操作（已不是保管人）
curl -X PUT http://localhost:3000/api/boxes/BOX-MAIN-001/status/STORE_ACCEPTED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "李厨师",
    "operator_type": "KITCHEN",
    "new_custodian": "王店长",
    "new_custodian_type": "STORE",
    "temperature": 4.9,
    "timestamp": "2026-06-07 14:00:00"
  }'
```

### 11.3 缺时间戳

```bash
curl -X PUT http://localhost:3000/api/boxes/BOX-MAIN-001/status/STORE_ACCEPTED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "张司机",
    "operator_type": "DRIVER",
    "new_custodian": "王店长",
    "new_custodian_type": "STORE",
    "temperature": 4.9
  }'
```

### 11.4 非数字温度

```bash
curl -X POST http://localhost:3000/api/temperature \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-MAIN-001",
    "temperature": "abc",
    "timestamp": "2026-06-07 14:00:00",
    "recorded_by": "张司机"
  }'
```

### 11.5 隔离后继续正常验收（失败）

```bash
# 先创建并隔离一个餐盒
curl -X POST http://localhost:3000/api/boxes \
  -H "Content-Type: application/json" \
  -d '{
    "box_no": "BOX-ISO-001",
    "batch_no": "BATCH-ISO",
    "kitchen_staff": "李厨师",
    "meal_items": [{"name": "测试套餐", "quantity": 1}]
  }'

curl -X PUT http://localhost:3000/api/boxes/BOX-ISO-001/status/MEAL_PREPARED \
  -H "Content-Type: application/json" \
  -d '{"operator": "李厨师", "operator_type": "KITCHEN"}'

curl -X PUT http://localhost:3000/api/boxes/BOX-ISO-001/status/BOXED \
  -H "Content-Type: application/json" \
  -d '{"operator": "李厨师", "operator_type": "KITCHEN"}'

curl -X PUT http://localhost:3000/api/boxes/BOX-ISO-001/status/DRIVER_RECEIVED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "李厨师",
    "operator_type": "KITCHEN",
    "new_custodian": "张司机",
    "new_custodian_type": "DRIVER"
  }'

curl -X PUT http://localhost:3000/api/boxes/BOX-ISO-001/status/EXCEPTION_ISOLATED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "张司机",
    "operator_type": "DRIVER",
    "new_custodian": "赵质控",
    "new_custodian_type": "QC",
    "exception_reason": "温度超标"
  }'

# 尝试从隔离状态直接验收（失败）
curl -X PUT http://localhost:3000/api/boxes/BOX-ISO-001/status/STORE_ACCEPTED \
  -H "Content-Type: application/json" \
  -d '{
    "operator": "赵质控",
    "operator_type": "QC",
    "new_custodian": "王店长",
    "new_custodian_type": "STORE",
    "temperature": 4.9,
    "timestamp": "2026-06-07 14:00:00"
  }'
```

---

## 十二、数据持久化验证

重启服务后执行以下查询，验证数据一致性：

```bash
# 验证批次状态
curl http://localhost:3000/api/boxes/BOX-MAIN-001

# 验证规则版本
curl http://localhost:3000/api/configs

# 验证审计日志
curl "http://localhost:3000/api/audit-logs?box_no=BOX-MAIN-001"

# 验证温度记录（从详情中查看）
curl http://localhost:3000/api/boxes/BOX-MAIN-001

# 验证导出历史
curl http://localhost:3000/api/export-history
```

---

## 错误响应格式

所有错误响应统一格式：

```json
{
  "success": false,
  "error": "错误信息描述"
}
```

参数验证错误会包含详细错误列表：

```json
{
  "success": false,
  "error": "参数验证失败",
  "details": ["温度必须为有效数字", "时间戳是必填项"]
}
```

---

## 内置样例数据

服务首次启动会自动创建5个样例餐盒，覆盖不同状态：

- `BOX-SAMPLE-001` - 门店已验收
- `BOX-SAMPLE-002` - 司机配送中
- `BOX-SAMPLE-003` - 异常已隔离
- `BOX-SAMPLE-004` - 已装箱待取
- `BOX-SAMPLE-005` - 已归档
