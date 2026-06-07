#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import time

BASE_URL = 'http://localhost:3000/api'

def log_pass(msg):
    print(f'✓ PASS: {msg}')

def log_fail(msg, error=None):
    print(f'✗ FAIL: {msg}')
    if error:
        print(f'  错误: {error}')
    sys.exit(1)

def pprint(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))

def run_tests():
    print('========================================')
    print('  导出更正追溯能力 - Python 接口测试')
    print('========================================\n')

    BOX_NO = f'BOX-PY-EXPORT-{int(time.time())}'
    BATCH_NO = f'BATCH-PY-EXPORT-{int(time.time())}'
    temp_record_id = None
    correction_id = None
    handover_doc_no = None
    exception_doc_no = None
    original_snapshot_time = None
    new_doc_no = None

    try:
        print('--- 场景1: 健康检查 ---')
        resp = requests.get(f'{BASE_URL}/health')
        data = resp.json()
        if data.get('success') and data['data'].get('status') == 'running':
            log_pass('服务运行正常')
        else:
            log_fail('服务健康检查失败', data)

        print('\n--- 场景2: 初始化测试数据 ---')
        resp = requests.post(f'{BASE_URL}/boxes', json={
            'box_no': BOX_NO,
            'batch_no': BATCH_NO,
            'kitchen_staff': '李厨师',
            'meal_items': [{'name': '红烧肉套餐', 'quantity': 2, 'price': 35}]
        })
        resp.raise_for_status()

        status_flow = [
            {'status': 'MEAL_PREPARED', 'operator': '李厨师', 'operator_type': 'KITCHEN'},
            {'status': 'BOXED', 'operator': '李厨师', 'operator_type': 'KITCHEN'},
            {
                'status': 'DRIVER_RECEIVED',
                'operator': '李厨师',
                'operator_type': 'KITCHEN',
                'new_custodian': '王司机',
                'new_custodian_type': 'DRIVER',
                'temperature': 4.5
            }
        ]

        for step in status_flow:
            resp = requests.put(
                f'{BASE_URL}/boxes/{BOX_NO}/status/{step["status"]}',
                json=step
            )
            resp.raise_for_status()

        resp = requests.post(f'{BASE_URL}/temperature', json={
            'box_no': BOX_NO,
            'temperature': 15.0,
            'timestamp': '2026-06-07 13:00:00',
            'recorded_by': '王司机'
        })
        resp.raise_for_status()
        temp_record_id = resp.json()['data']['id']
        log_pass(f'测试数据初始化完成，温度记录ID: {temp_record_id}')

        print('\n--- 场景3: 普通导出交接单，验证包含更正快照 ---')
        resp = requests.post(f'{BASE_URL}/export/handover/{BOX_NO}', json={
            'operator': '王店长'
        })
        resp.raise_for_status()
        data = resp.json()
        handover_doc_no = data['data']['doc_no']

        if 'correction_snapshot' not in data['data']:
            log_fail('交接单未包含correction_snapshot字段')

        snapshot = data['data']['correction_snapshot']
        if not snapshot.get('snapshot_time') or not snapshot.get('overall'):
            log_fail('更正快照格式不正确')
        if BATCH_NO not in snapshot.get('batch_summaries', {}):
            log_fail('更正快照未包含批次信息')

        original_snapshot_time = snapshot['snapshot_time']
        log_pass(f'交接单导出成功，单据号: {handover_doc_no}，快照时间: {original_snapshot_time}')

        print('\n--- 场景4: 普通导出异常清单，验证包含更正快照 ---')
        resp = requests.post(f'{BASE_URL}/export/exceptions', json={
            'operator': '赵质控'
        })
        resp.raise_for_status()
        data = resp.json()
        exception_doc_no = data['data']['doc_no']

        if 'correction_snapshot' not in data['data']:
            log_fail('异常清单未包含correction_snapshot字段')

        log_pass(f'异常清单导出成功，单据号: {exception_doc_no}')

        print('\n--- 场景5: 提交更正申请 ---')
        resp = requests.post(f'{BASE_URL}/corrections', json={
            'box_no': BOX_NO,
            'record_type': 'temperature',
            'record_id': temp_record_id,
            'field_name': 'temperature',
            'proposed_value': '4.8',
            'apply_reason': '温度单位误操作',
            'applicant': '王司机',
            'applicant_type': 'DRIVER'
        })
        resp.raise_for_status()
        correction_id = resp.json()['data']['id']
        log_pass(f'更正申请提交成功，ID: {correction_id}')

        print('\n--- 场景6: 验证历史单据快照未被悄悄改写 ---')
        resp = requests.get(f'{BASE_URL}/export/{handover_doc_no}')
        resp.raise_for_status()
        check_snapshot = resp.json()['data']['correction_snapshot']

        if check_snapshot['snapshot_time'] != original_snapshot_time:
            log_fail(f'快照时间被修改！原: {original_snapshot_time}, 现: {check_snapshot["snapshot_time"]}')

        if check_snapshot['overall']['total_corrections'] != 0:
            log_fail(f'快照被改写！原更正总数应为0，现为: {check_snapshot["overall"]["total_corrections"]}')

        log_pass('历史单据快照保持不变，未被后续更正申请改写')

        print('\n--- 场景7: QC审核更正申请 ---')
        resp = requests.put(f'{BASE_URL}/corrections/{correction_id}/review', json={
            'reviewer': '赵质控',
            'reviewer_type': 'QC',
            'review_result': 'APPROVED',
            'review_reason': '经核实，温度记录确实有误'
        })
        resp.raise_for_status()
        log_pass('更正申请审核通过')

        print('\n--- 场景8: 再次验证历史单据快照未变 ---')
        resp = requests.get(f'{BASE_URL}/export/{handover_doc_no}')
        resp.raise_for_status()
        check_snapshot2 = resp.json()['data']['correction_snapshot']

        if check_snapshot2['overall']['approved_count'] != 0:
            log_fail(f'快照被改写！已通过数量应为0，现为: {check_snapshot2["overall"]["approved_count"]}')

        if check_snapshot2['overall']['pending_count'] != 0:
            log_fail(f'快照被改写！待审核数量应为0，现为: {check_snapshot2["overall"]["pending_count"]}')

        log_pass('审核后历史快照仍保持不变，符合预期')

        print('\n--- 场景9: 非QC角色重新导出被拒 ---')
        try:
            resp = requests.post(f'{BASE_URL}/export/{handover_doc_no}/reexport', json={
                'operator': '王司机',
                'operator_type': 'DRIVER',
                'reexport_reason': '测试非QC权限'
            })
            if resp.status_code == 403 and 'QC' in resp.json().get('error', ''):
                log_pass('非QC角色重新导出被正确拒绝，返回403')
            else:
                log_fail('非QC角色应该被拒绝，但请求成功了', resp.json())
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 403 and 'QC' in e.response.json().get('error', ''):
                log_pass('非QC角色重新导出被正确拒绝，返回403')
            else:
                raise

        print('\n--- 场景10: QC重新导出成功 ---')
        resp = requests.post(f'{BASE_URL}/export/{handover_doc_no}/reexport', json={
            'operator': '赵质控',
            'operator_type': 'QC',
            'reexport_reason': '更正已审核通过，更新单据快照'
        })
        resp.raise_for_status()
        data = resp.json()

        new_doc_no = data['data']['new_doc_no']
        if not new_doc_no or new_doc_no == handover_doc_no:
            log_fail('重新导出未生成新单据号')

        if data['data']['version'] != 2:
            log_fail(f'版本号应为2，现为: {data["data"]["version"]}')

        if not data['data'].get('correction_summary'):
            log_fail('缺少更正摘要信息')

        log_pass(f'重新导出成功，新单据号: {new_doc_no}，版本: 2')
        log_pass(f'更正摘要: {data["data"]["correction_summary"]}')

        print('\n--- 场景11: 验证新单据快照已更新 ---')
        resp = requests.get(f'{BASE_URL}/export/{new_doc_no}')
        resp.raise_for_status()
        new_snapshot = resp.json()['data']['correction_snapshot']

        if new_snapshot['overall']['total_corrections'] != 1:
            log_fail(f'新快照更正总数应为1，现为: {new_snapshot["overall"]["total_corrections"]}')

        if new_snapshot['overall']['approved_count'] != 1:
            log_fail(f'新快照已通过数量应为1，现为: {new_snapshot["overall"]["approved_count"]}')

        if new_snapshot['overall']['pending_count'] != 0:
            log_fail(f'新快照待审核数量应为0，现为: {new_snapshot["overall"]["pending_count"]}')

        batch_summary = new_snapshot['batch_summaries'][BATCH_NO]
        if not batch_summary.get('latest_reviewer') or batch_summary['latest_reviewer'] != '赵质控':
            log_fail('新快照未包含最近审核人信息')

        if not batch_summary.get('latest_review_reason'):
            log_fail('新快照未包含最近审核原因')

        log_pass('新单据快照已正确更新，包含审核状态和审核人信息')
        log_pass(f'最近审核人: {batch_summary["latest_reviewer"]}')
        log_pass(f'最近审核原因: {batch_summary["latest_review_reason"]}')

        print('\n--- 场景12: 验证审计日志 ---')
        resp = requests.get(f'{BASE_URL}/audit-logs?action=DOCUMENT_REEXPORT')
        resp.raise_for_status()
        logs = resp.json()['data']

        reexport_logs = []
        for log in logs:
            details = json.loads(log['details']) if isinstance(log['details'], str) else log['details']
            if details.get('new_doc_no') == new_doc_no:
                reexport_logs.append(log)

        if len(reexport_logs) == 0:
            log_fail('未找到重新导出的审计日志')

        log_details = json.loads(reexport_logs[0]['details'])
        required_fields = ['old_doc_no', 'new_doc_no', 'reexport_reason', 'correction_summary']
        for field in required_fields:
            if not log_details.get(field):
                log_fail(f'审计日志缺少必要字段: {field}')

        log_pass('审计日志记录完整')
        log_pass(f'  旧单据号: {log_details["old_doc_no"]}')
        log_pass(f'  新单据号: {log_details["new_doc_no"]}')
        log_pass(f'  重新导出原因: {log_details["reexport_reason"]}')
        log_pass(f'  更正摘要: {log_details["correction_summary"]}')

        print('\n--- 场景13: 验证导出历史接口返回快照 ---')
        resp = requests.get(f'{BASE_URL}/export-history?box_no={BOX_NO}')
        resp.raise_for_status()
        history = resp.json()['data']

        has_snapshot = all(d.get('correction_snapshot') is not None for d in history)
        if not has_snapshot:
            log_fail('导出历史中存在单据缺少更正快照')

        log_pass(f'导出历史接口正确返回 {len(history)} 条单据的更正快照')

        print('\n--- 场景14: 关闭重新导出开关，验证功能被禁用 ---')
        resp = requests.post(f'{BASE_URL}/config', json={
            'operator': '系统管理员',
            'version': 'v1.0.0-py-reexport-off',
            'temp_min': 0,
            'temp_max': 8,
            'delivery_time_limit': 120,
            'correction_review_time_limit': 24,
            'allow_reexport': False,
            'acceptance_rules': {
                'require_temperature_check': True,
                'require_timestamp': True,
                'max_acceptable_temp_deviation': 2,
                'require_custodian_verification': True,
                'allow_partial_acceptance': False
            }
        })
        resp.raise_for_status()

        try:
            resp = requests.post(f'{BASE_URL}/export/{handover_doc_no}/reexport', json={
                'operator': '赵质控',
                'operator_type': 'QC',
                'reexport_reason': '测试配置关闭'
            })
            if resp.status_code == 403 and '关闭' in resp.json().get('error', ''):
                log_pass('配置关闭时重新导出被正确拒绝')
            else:
                log_fail('配置关闭时应该被拒绝，但请求成功了', resp.json())
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 403 and '关闭' in e.response.json().get('error', ''):
                log_pass('配置关闭时重新导出被正确拒绝')
            else:
                raise

        print('\n--- 场景15: 恢复默认配置 ---')
        resp = requests.post(f'{BASE_URL}/config', json={
            'operator': '系统管理员',
            'version': 'v1.0.0-py-reexport-on',
            'temp_min': 0,
            'temp_max': 8,
            'delivery_time_limit': 120,
            'correction_review_time_limit': 24,
            'allow_reexport': True,
            'acceptance_rules': {
                'require_temperature_check': True,
                'require_timestamp': True,
                'max_acceptable_temp_deviation': 2,
                'require_custodian_verification': True,
                'allow_partial_acceptance': False
            }
        })
        resp.raise_for_status()
        log_pass('已恢复默认配置（allow_reexport=True）')

        print('\n--- 场景16: 验证配置接口返回allow_reexport ---')
        resp = requests.get(f'{BASE_URL}/config')
        resp.raise_for_status()
        config = resp.json()['data']

        if 'allow_reexport' not in config:
            log_fail('配置接口未返回allow_reexport字段')

        if config['allow_reexport'] is not True:
            log_fail(f'allow_reexport应为True，现为: {config["allow_reexport"]}')

        log_pass(f'配置接口正确返回 allow_reexport = {config["allow_reexport"]}')

        print('\n--- 场景17: 验证打印格式包含快照信息 ---')
        resp = requests.post(f'{BASE_URL}/export/handover/{BOX_NO}', json={
            'operator': '王店长'
        })
        resp.raise_for_status()
        data = resp.json()

        if '更正快照' not in data['data'].get('printable_format', ''):
            log_fail('交接单打印格式未包含更正快照信息')

        log_pass('打印格式正确包含更正快照摘要')

        print('\n--- 场景18: 验证快照包含过期标记和冲突数量 ---')
        batch = new_snapshot['batch_summaries'][BATCH_NO]
        corrections = batch['corrections']

        for corr in corrections:
            if 'is_expired' not in corr:
                log_fail('更正快照未包含is_expired字段')
            if 'has_conflict' not in corr:
                log_fail('更正快照未包含has_conflict字段')
            if 'status_label' not in corr:
                log_fail('更正快照未包含status_label字段')

        log_pass('更正快照包含所有必要字段: is_expired, has_conflict, status_label')

        print('\n========================================')
        print('  ✓ 所有 Python 测试场景通过！')
        print('========================================\n')

        print('测试数据参考（用于重启后验证）:')
        print(f'  测试箱号: {BOX_NO}')
        print(f'  测试批次: {BATCH_NO}')
        print(f'  原始交接单: {handover_doc_no}')
        print(f'  原始快照时间: {original_snapshot_time}')
        print(f'  原始快照状态: 总0, 已通过0, 待审0')
        print(f'  重新导出交接单: {new_doc_no}')
        print(f'  新快照状态: 总1, 已通过1, 待审0')
        print()
        print('重启服务后可执行以下命令验证:')
        print(f'  python test-export-correction-python.py --verify {handover_doc_no} "{original_snapshot_time}" 0 0 0')
        print(f'  python test-export-correction-python.py --verify {new_doc_no} "" 1 1 0')

    except requests.exceptions.RequestException as e:
        log_fail('HTTP请求异常', str(e))
    except Exception as e:
        log_fail('测试执行异常', str(e))

def verify_after_restart():
    args = sys.argv[2:]
    if len(args) < 1:
        print('用法: python test-export-correction-python.py --verify <单据号> [期望快照时间] [期望更正总数] [期望已通过数] [期望待审核数]')
        print('示例: python test-export-correction-python.py --verify HJD202606071234 "2026-06-07 14:30:00" 1 1 0')
        return

    DOC_NO = args[0]
    EXPECTED_TIME = args[1] if len(args) > 1 else None
    EXPECTED_TOTAL = int(args[2]) if len(args) > 2 else 0
    EXPECTED_APPROVED = int(args[3]) if len(args) > 3 else 0
    EXPECTED_PENDING = int(args[4]) if len(args) > 4 else 0

    print('========================================')
    print('  服务重启后快照验证 (Python)')
    print('========================================\n')
    print(f'验证单据: {DOC_NO}')
    print()

    try:
        resp = requests.get(f'{BASE_URL}/export/{DOC_NO}')
        resp.raise_for_status()
        data = resp.json()

        if not data.get('success'):
            log_fail(f'查询失败: {data.get("error")}')

        doc = data['data']
        snapshot = doc.get('correction_snapshot')

        if not snapshot:
            log_fail('单据未包含更正快照')
        log_pass('✓ 单据存在，且包含更正快照')

        if EXPECTED_TIME and snapshot['snapshot_time'] != EXPECTED_TIME:
            log_fail(f'快照时间不匹配！期望: {EXPECTED_TIME}, 实际: {snapshot["snapshot_time"]}')
        log_pass(f'✓ 快照时间正确: {snapshot["snapshot_time"]}')

        if snapshot['overall']['total_corrections'] != EXPECTED_TOTAL:
            log_fail(f'更正总数不匹配！期望: {EXPECTED_TOTAL}, 实际: {snapshot["overall"]["total_corrections"]}')
        log_pass(f'✓ 更正总数正确: {snapshot["overall"]["total_corrections"]}')

        if snapshot['overall']['approved_count'] != EXPECTED_APPROVED:
            log_fail(f'已通过数量不匹配！期望: {EXPECTED_APPROVED}, 实际: {snapshot["overall"]["approved_count"]}')
        log_pass(f'✓ 已通过数量正确: {snapshot["overall"]["approved_count"]}')

        if snapshot['overall']['pending_count'] != EXPECTED_PENDING:
            log_fail(f'待审核数量不匹配！期望: {EXPECTED_PENDING}, 实际: {snapshot["overall"]["pending_count"]}')
        log_pass(f'✓ 待审核数量正确: {snapshot["overall"]["pending_count"]}')

        log_pass(f'✓ 已过期数量: {snapshot["overall"]["expired_count"]}')
        log_pass(f'✓ 冲突数量: {snapshot["overall"]["conflict_count"]}')
        log_pass(f'✓ 是否重新导出: {"是" if doc.get("is_reexport") else "否"}')
        log_pass(f'✓ 版本号: {doc.get("version", "N/A")}')
        if doc.get('parent_doc_no'):
            log_pass(f'✓ 父单据号: {doc["parent_doc_no"]}')

        print('\n========================================')
        print('  ✓ 重启后快照验证通过！')
        print('  ✓ 快照数据持久化正常，未被改写')
        print('========================================')

    except Exception as e:
        log_fail('重启后验证失败', str(e))

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--verify':
        verify_after_restart()
    else:
        run_tests()
