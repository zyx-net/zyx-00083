#!/usr/bin/env python3
"""
更正申请过期后冲突重算 - Python requests 接口链路测试
覆盖：同批2条待审，1条过期后另一条冲突状态清除
"""
import requests
import json
import time
from datetime import datetime, timedelta

BASE_URL = "http://localhost:3000"
TEST_ID = int(time.time())
BOX_NO = f"BOX-PY-CONFLICT-{TEST_ID}"
BATCH_NO = f"BATCH-PY-CONFLICT-{TEST_ID}"

def log(step, message):
    print(f"\n=== 步骤{step}: {message} ===")

def api_call(path, method="GET", data=None):
    url = f"{BASE_URL}{path}"
    headers = {"Content-Type": "application/json"} if data else {}
    try:
        if method == "GET":
            resp = requests.get(url, timeout=10)
        elif method == "POST":
            resp = requests.post(url, json=data, headers=headers, timeout=10)
        elif method == "PUT":
            resp = requests.put(url, json=data, headers=headers, timeout=10)
        return {
            "status": resp.status_code,
            "data": resp.json(),
            "is_success": resp.json().get("success", False)
        }
    except Exception as e:
        return {"status": 0, "error": str(e), "is_success": False}

def test(name, actual, expected):
    passed = actual == expected
    status = "✓ PASS" if passed else "✗ FAIL"
    print(f"  {status}  {name}")
    if not passed:
        print(f"         期望: {expected}")
        print(f"         实际: {actual}")
    return passed

def run_tests():
    print("=" * 70)
    print("  Python requests - 更正申请过期冲突重算接口链路测试")
    print("=" * 70)
    print(f"  测试批次: {BATCH_NO}")
    print(f"  测试时间: {datetime.now().isoformat()}")
    print("=" * 70)

    pass_count = 0
    fail_count = 0

    # 步骤1: 准备测试数据
    log(1, "准备测试数据 - 创建餐盒并流转")
    
    r = api_call("/api/boxes", "POST", {
        "box_no": BOX_NO,
        "batch_no": BATCH_NO,
        "kitchen_staff": "李厨师",
        "meal_items": [{"name": "测试套餐", "quantity": 1, "price": 25}]
    })
    pass_count += test("创建餐盒成功", r["is_success"] and r["status"] == 201, True)

    for status in ["MEAL_PREPARED", "BOXED", "DRIVER_RECEIVED"]:
        body = {"operator": "李厨师", "operator_type": "KITCHEN"}
        if status == "DRIVER_RECEIVED":
            body.update({
                "new_custodian": "王司机",
                "new_custodian_type": "DRIVER",
                "temperature": 4.5
            })
        r = api_call(f"/api/boxes/{BOX_NO}/status/{status}", "PUT", body)
        pass_count += test(f"流转到{status}成功", r["is_success"] and r["status"] == 200, True)

    r = api_call("/api/temperature", "POST", {
        "box_no": BOX_NO,
        "temperature": 15.0,
        "timestamp": "2026-06-07 13:00:00",
        "recorded_by": "王司机"
    })
    pass_count += test("上报温度记录成功", r["is_success"] and r["status"] == 201, True)

    r = api_call(f"/api/boxes/{BOX_NO}", "GET")
    status_record_id = r["data"]["status_history"][3]["id"]
    temp_record_id = r["data"]["temperature_readings"][0]["id"]
    pass_count += test("获取餐盒详情成功", r["is_success"], True)

    # 步骤2: 提交2条更正申请
    log(2, "提交2条更正申请（同批次）")

    r = api_call("/api/corrections", "POST", {
        "box_no": BOX_NO,
        "record_type": "temperature",
        "record_id": temp_record_id,
        "field_name": "temperature",
        "proposed_value": "4.8",
        "apply_reason": "Python测试冲突1",
        "applicant": "王司机",
        "applicant_type": "DRIVER"
    })
    corr1_id = r["data"]["id"]
    pass_count += test("第1条提交成功，无冲突警告", 
        r["is_success"] and r["data"]["conflict_warning"] == 0, True)
    print(f"  更正1: id={corr1_id}, conflict_warning={r['data']['conflict_warning']}")

    r = api_call("/api/corrections", "POST", {
        "box_no": BOX_NO,
        "record_type": "status_history",
        "record_id": status_record_id,
        "field_name": "operator",
        "proposed_value": "张司机",
        "apply_reason": "Python测试冲突2",
        "applicant": "李店长",
        "applicant_type": "STORE"
    })
    corr2_id = r["data"]["id"]
    pass_count += test("第2条提交成功，检测到冲突警告",
        r["is_success"] and r["data"]["conflict_warning"] == 1 and r["data"]["has_active_conflicts"] == True, True)
    print(f"  更正2: id={corr2_id}, conflict_warning={r['data']['conflict_warning']}, has_active_conflicts={r['data']['has_active_conflicts']}")

    # 验证批次状态
    r = api_call(f"/api/corrections/batch/{BATCH_NO}/status", "GET")
    pass_count += test("批次状态: pending=2, has_conflicts=true",
        r["is_success"] and r["data"]["pending_count"] == 2 and r["data"]["has_conflicts"] == True, True)
    print(f"  批次: pending_count={r['data']['pending_count']}, has_conflicts={r['data']['has_conflicts']}")

    # 步骤3: 直接用API模拟过期（通过数据库操作）
    log(3, "让第1条更正过期（通过Node.js脚本修改数据库）")
    
    import subprocess
    past_time = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")
    sql_script = f"""
    const {{ initDatabase, run }} = require('./src/database/init');
    (async function() {{
        await initDatabase();
        await run('UPDATE correction_applications SET expires_at = ? WHERE id = ?',
            ['{past_time}', {corr1_id}]);
        console.log('Updated expires_at to {past_time} for correction {corr1_id}');
        process.exit(0);
    }})();
    """
    with open("temp_update_expires.js", "w", encoding="utf-8") as f:
        f.write(sql_script)
    subprocess.run(["node", "temp_update_expires.js"], cwd="d:\\workSpace\\AI__SPACE\\zyx-00083", capture_output=True)
    import os
    os.remove("temp_update_expires.js")
    print(f"  已将更正{corr1_id}的expires_at设为: {past_time}")

    # 步骤4: 查询更正2详情 - 应触发过期检测并重算冲突
    log(4, "查询更正2详情（触发过期检测和冲突重算）")
    
    r = api_call(f"/api/corrections/{corr2_id}", "GET")
    print(f"  更正2状态: {r['data']['status']} ({r['data']['status_label']})")
    print(f"  更正2 conflict_warning: {r['data']['conflict_warning']}")
    print(f"  更正2 has_active_conflicts: {r['data']['has_active_conflicts']}")
    print(f"  更正2 other_pending_count: {r['data']['other_pending_count']}")
    
    pass_count += test("更正2仍为待审核状态", 
        r["is_success"] and r["data"]["status"] == "PENDING", True)
    pass_count += test("更正2 has_active_conflicts=false（无冲突）",
        r["data"]["has_active_conflicts"] == False and r["data"]["other_pending_count"] == 0, True)
    pass_count += test("更正2 conflict_warning=0",
        r["data"]["conflict_warning"] == 0, True)

    # 步骤5: 验证更正1已自动标记为过期
    log(5, "验证更正1已自动标记为EXPIRED")
    
    r = api_call(f"/api/corrections/{corr1_id}", "GET")
    print(f"  更正1状态: {r['data']['status']} ({r['data']['status_label']})")
    pass_count += test("更正1已自动标记为EXPIRED",
        r["is_success"] and r["data"]["status"] == "EXPIRED" and r["data"]["status_label"] == "已过期", True)

    # 步骤6: 验证批次状态已更新
    log(6, "验证批次状态已更新")
    
    r = api_call(f"/api/corrections/batch/{BATCH_NO}/status", "GET")
    print(f"  批次 pending_count: {r['data']['pending_count']}")
    print(f"  批次 expired_count: {r['data']['expired_count']}")
    print(f"  批次 has_conflicts: {r['data']['has_conflicts']}")
    
    pass_count += test("批次状态: pending=1, expired=1, has_conflicts=false",
        r["is_success"] and 
        r["data"]["pending_count"] == 1 and
        r["data"]["expired_count"] == 1 and
        r["data"]["has_conflicts"] == False, True)

    pending_corr = [c for c in r["data"]["all_corrections"] if c["status"] == "PENDING"]
    pass_count += test("剩余待审的conflict_warning=0",
        len(pending_corr) == 1 and pending_corr[0]["conflict_warning"] == 0, True)

    # 步骤7: 验证过期申请不能被审核
    log(7, "验证过期申请不能通过/驳回")
    
    r = api_call(f"/api/corrections/{corr1_id}/review", "PUT", {
        "reviewer": "赵质控",
        "reviewer_type": "QC",
        "review_result": "APPROVED",
        "review_reason": "尝试通过过期申请"
    })
    print(f"  通过过期申请: status={r['status']}, error={r['data'].get('error', '')}")
    pass_count += test("通过过期申请返回400错误",
        r["status"] == 400 and "已超过审核时限" in r["data"].get("error", ""), True)

    r = api_call(f"/api/corrections/{corr1_id}/review", "PUT", {
        "reviewer": "赵质控",
        "reviewer_type": "QC",
        "review_result": "REJECTED",
        "review_reason": "尝试驳回过期申请"
    })
    print(f"  驳回过期申请: status={r['status']}, error={r['data'].get('error', '')}")
    pass_count += test("驳回过期申请返回400错误",
        r["status"] == 400 and "已过期" in r["data"].get("error", ""), True)

    # 步骤8: 验证正常审核不受影响
    log(8, "验证正常审核不受影响")
    
    r = api_call(f"/api/corrections/{corr2_id}/review", "PUT", {
        "reviewer": "赵质控",
        "reviewer_type": "QC",
        "review_result": "APPROVED",
        "review_reason": "同意更正，无冲突"
    })
    print(f"  正常审核: status={r['data']['status']}, has_active_conflicts={r['data']['has_active_conflicts']}")
    pass_count += test("正常审核通过成功",
        r["is_success"] and r["data"]["status"] == "APPROVED", True)

    r = api_call(f"/api/corrections/batch/{BATCH_NO}/status", "GET")
    pass_count += test("最终批次状态: pending=0, approved=1, expired=1",
        r["is_success"] and
        r["data"]["pending_count"] == 0 and
        r["data"]["approved_count"] == 1 and
        r["data"]["expired_count"] == 1 and
        r["data"]["has_conflicts"] == False, True)

    # 步骤9: 验证异常清单导出
    log(9, "验证异常清单导出显示正确状态")
    
    api_call(f"/api/boxes/{BOX_NO}/status/EXCEPTION_ISOLATED", "PUT", {
        "operator": "王司机",
        "operator_type": "DRIVER",
        "new_custodian": "赵质控",
        "new_custodian_type": "QC",
        "exception_reason": "温度超标"
    })

    r = api_call("/api/export/exceptions", "POST", {"operator": "赵质控"})
    box_export = next((e for e in r["data"]["exceptions"] if e["box_no"] == BOX_NO), None)
    
    print(f"  导出 correction_status:")
    print(f"    pending_count: {box_export['correction_status']['pending_count']}")
    print(f"    expired_count: {box_export['correction_status']['expired_count']}")
    print(f"    approved_count: {box_export['correction_status']['approved_count']}")
    print(f"    has_conflicts: {box_export['correction_status']['has_conflicts']}")
    
    pass_count += test("导出: expired_count=1, approved_count=1, has_conflicts=false",
        box_export["correction_status"]["expired_count"] == 1 and
        box_export["correction_status"]["approved_count"] == 1 and
        box_export["correction_status"]["has_conflicts"] == False, True)

    printable = r["data"]["printable_format"]
    pass_count += test('打印格式包含"已过期1条"', "已过期1条" in printable, True)

    # 步骤10: 验证审计日志不重复
    log(10, "验证审计日志（不重复记录）")
    
    r = api_call("/api/audit-logs?action=CORRECTION_EXPIRED", "GET")
    expired_logs = [l for l in r["data"] if f'"correction_id":{corr1_id}' in l.get("details", "")]
    print(f"  CORRECTION_EXPIRED日志数（更正{corr1_id}）: {len(expired_logs)}")
    
    pass_count += test("过期审计日志仅1条（无重复）", len(expired_logs) == 1, True)
    
    if expired_logs:
        details = json.loads(expired_logs[0]["details"])
        print(f"  日志: operator={expired_logs[0]['operator']}, expired_at={details.get('expired_at', 'N/A')}")
        pass_count += test("日志操作者为SYSTEM", expired_logs[0]["operator"] == "SYSTEM", True)
        pass_count += test("日志包含触发时间expired_at", "expired_at" in details, True)

    # 再次查询确认不重复
    api_call(f"/api/corrections/{corr1_id}", "GET")
    r = api_call("/api/audit-logs?action=CORRECTION_EXPIRED", "GET")
    expired_logs2 = [l for l in r["data"] if f'"correction_id":{corr1_id}' in l.get("details", "")]
    pass_count += test("再次查询后日志数仍为1（不重复）", len(expired_logs2) == 1, True)
    print(f"  再次查询后日志数: {len(expired_logs2)}")

    # 总结
    print("\n" + "=" * 70)
    print("  测试总结")
    print("=" * 70)
    total = pass_count + fail_count
    print(f"  总测试数: {total}")
    print(f"  通过: {pass_count}")
    print(f"  失败: {fail_count}")
    print(f"  通过率: {(pass_count/total*100):.2f}%")
    print("=" * 70)

    return fail_count == 0

if __name__ == "__main__":
    success = run_tests()
    exit(0 if success else 1)
