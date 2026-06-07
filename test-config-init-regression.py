#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配置初始化修复 - 回归测试
覆盖用户可见链路:
1. 无 active 但保留 v1.0.0 后重启成功
2. 配置关闭重新导出
3. 导出详情和历史快照仍可读
4. 重新导出接口功能正常
"""

import requests
import sqlite3
import time
import json
import sys
import os
import subprocess
from datetime import datetime

BASE_URL = 'http://localhost:3000/api'
BOX_NO = 'BOX-SAMPLE-001'
BATCH_NO = 'BATCH-SAMPLE-001'

def log_pass(msg):
    print(f'✓ PASS: {msg}')

def log_fail(msg, error=None):
    print(f'✗ FAIL: {msg}')
    if error:
        print(f'  错误: {str(error)}')
    sys.exit(1)

def setup_db_no_active_v1():
    """准备数据库: 有 v1.0.0 但 is_active = 0"""
    db_path = os.path.join(os.path.dirname(__file__), 'data', 'tracking.db')
    
    if os.path.exists(db_path):
        os.remove(db_path)
    
    data_dir = os.path.dirname(db_path)
    if not os.path.exists(data_dir):
        os.makedirs(data_dir, exist_ok=True)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('''CREATE TABLE IF NOT EXISTS configurations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        temp_min REAL NOT NULL,
        temp_max REAL NOT NULL,
        delivery_time_limit INTEGER NOT NULL,
        acceptance_rules TEXT NOT NULL,
        correction_review_time_limit INTEGER DEFAULT 24,
        correctable_fields_whitelist TEXT DEFAULT '["current_custodian","temperature","timestamp","operator","custodian_type"]',
        allow_reexport INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 0
    )''')
    
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    cursor.execute('''INSERT INTO configurations (
        version, temp_min, temp_max, delivery_time_limit, 
        acceptance_rules, correction_review_time_limit, 
        correctable_fields_whitelist, allow_reexport, created_at, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)''', (
        'v1.0.0', 0, 8, 120,
        json.dumps({'require_temperature_check': True}),
        24,
        json.dumps(['current_custodian', 'temperature', 'timestamp', 'operator', 'custodian_type']),
        1, now
    ))
    
    conn.commit()
    
    cursor.execute('SELECT version, is_active FROM configurations')
    row = cursor.fetchone()
    conn.close()
    
    assert row[0] == 'v1.0.0' and row[1] == 0, '数据库场景准备失败'
    print(f'✓ 数据库准备完成: version={row[0]}, is_active={row[1]}')
    return db_path

def setup_db_v1_with_reexport_off():
    """准备数据库: v1.0.0 active，但 allow_reexport = 0"""
    db_path = os.path.join(os.path.dirname(__file__), 'data', 'tracking.db')
    
    if os.path.exists(db_path):
        os.remove(db_path)
    
    data_dir = os.path.dirname(db_path)
    if not os.path.exists(data_dir):
        os.makedirs(data_dir, exist_ok=True)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('''CREATE TABLE IF NOT EXISTS configurations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        temp_min REAL NOT NULL,
        temp_max REAL NOT NULL,
        delivery_time_limit INTEGER NOT NULL,
        acceptance_rules TEXT NOT NULL,
        correction_review_time_limit INTEGER DEFAULT 24,
        correctable_fields_whitelist TEXT DEFAULT '["current_custodian","temperature","timestamp","operator","custodian_type"]',
        allow_reexport INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 0
    )''')
    
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    cursor.execute('''INSERT INTO configurations (
        version, temp_min, temp_max, delivery_time_limit, 
        acceptance_rules, correction_review_time_limit, 
        correctable_fields_whitelist, allow_reexport, created_at, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)''', (
        'v1.0.0', 0, 8, 120,
        json.dumps({'require_temperature_check': True}),
        24,
        json.dumps(['current_custodian', 'temperature', 'timestamp', 'operator', 'custodian_type']),
        0, now
    ))
    
    conn.commit()
    conn.close()
    print('✓ 数据库准备完成: v1.0.0 active, allow_reexport=0')

def wait_for_server(timeout=30):
    print('  等待服务启动...', end='', flush=True)
    start = time.time()
    while time.time() - start < timeout:
        try:
            resp = requests.get(f'{BASE_URL}/health', timeout=2)
            if resp.status_code == 200:
                print(' 服务已启动!')
                return True
        except:
            pass
        print('.', end='', flush=True)
        time.sleep(1)
    print(' 服务启动超时!')
    return False

print('========================================')
print('  配置初始化修复 - 回归测试 (Python)')
print('========================================')
print()

print('=== 第一部分: 无 active 但保留 v1.0.0 后重启成功 ===')
print()

print('--- 场景1: 准备数据库 (v1.0.0 存在但 is_active=0) ---')
setup_db_no_active_v1()

print('\n--- 场景2: 启动服务，验证不崩溃 ---')
print('  (此场景验证修复前会因 UNIQUE 约束崩溃)')

encoding = 'utf-8' if sys.platform != 'win32' else 'gbk'
server_proc = subprocess.Popen(
    ['node', 'server.js'],
    cwd=os.path.dirname(__file__),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    encoding=encoding,
    errors='replace'
)

try:
    if not wait_for_server(30):
        server_proc.terminate()
        server_proc.wait()
        log_fail('服务启动失败 (修复前此处会因 UNIQUE 约束崩溃)')
    
    time.sleep(1)
    
    db_path = os.path.join(os.path.dirname(__file__), 'data', 'tracking.db')
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT version, is_active, allow_reexport FROM configurations WHERE is_active = 1')
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        log_fail('服务启动后仍无 active 配置')
    if row[0] != 'v1.0.0' or row[1] != 1:
        log_fail(f'active 配置不正确: version={row[0]}, is_active={row[1]}')
    
    log_pass(f'服务成功启动，未崩溃，v1.0.0 已自动恢复为 active (allow_reexport={row[2]})')

    print('\n--- 场景3: 验证健康检查和配置接口 ---')
    resp = requests.get(f'{BASE_URL}/health')
    resp.raise_for_status()
    assert resp.json()['success'] == True
    log_pass('健康检查接口正常')

    resp = requests.get(f'{BASE_URL}/config')
    resp.raise_for_status()
    config = resp.json()['data']
    assert config['version'] == 'v1.0.0'
    assert config['is_active'] == 1
    assert config['allow_reexport'] == True
    log_pass('配置接口返回正确: v1.0.0 active, allow_reexport=True')

    print('\n=== 第二部分: 导出详情和历史快照可读 ===')
    print()

    print('--- 场景4: 导出交接单 ---')
    resp = requests.post(f'{BASE_URL}/export/handover/{BOX_NO}', json={
        'operator': '王店长',
        'operator_type': 'STORE'
    })
    resp.raise_for_status()
    handover_data = resp.json()['data']
    handover_doc_no = handover_data['doc_no']
    assert handover_doc_no.startswith('HJD')
    assert 'correction_snapshot' in handover_data
    assert handover_data['correction_snapshot'] is not None
    log_pass(f'交接单导出成功: {handover_doc_no}，包含更正快照')

    print('\n--- 场景5: 导出异常清单 ---')
    resp = requests.post(f'{BASE_URL}/export/exceptions', json={
        'operator': '赵质控',
        'operator_type': 'QC'
    })
    resp.raise_for_status()
    exception_data = resp.json()['data']
    exception_doc_no = exception_data['doc_no']
    assert exception_doc_no.startswith('YCD')
    assert 'correction_snapshot' in exception_data
    log_pass(f'异常清单导出成功: {exception_doc_no}，包含更正快照')

    print('\n--- 场景6: 验证导出详情接口 ---')
    resp = requests.get(f'{BASE_URL}/export/{handover_doc_no}')
    resp.raise_for_status()
    detail_data = resp.json()['data']
    assert detail_data['doc_no'] == handover_doc_no
    assert 'correction_snapshot' in detail_data
    assert detail_data['correction_snapshot'] is not None
    snapshot = detail_data['correction_snapshot']
    assert 'snapshot_time' in snapshot
    assert 'overall' in snapshot
    assert 'batch_summaries' in snapshot
    log_pass('导出详情接口正常返回，包含完整更正快照')

    print('\n--- 场景7: 验证导出历史接口 ---')
    resp = requests.get(f'{BASE_URL}/export-history?box_no={BOX_NO}')
    resp.raise_for_status()
    history_data = resp.json()['data']
    assert len(history_data) >= 1
    has_snapshot = all(d.get('correction_snapshot') is not None for d in history_data)
    if not has_snapshot:
        log_fail('导出历史中存在单据缺少更正快照')
    log_pass(f'导出历史接口正常返回 {len(history_data)} 条记录，全部包含快照')

    print('\n--- 场景8: QC 重新导出成功 ---')
    resp = requests.post(f'{BASE_URL}/export/{handover_doc_no}/reexport', json={
        'operator': '赵质控',
        'operator_type': 'QC',
        'reexport_reason': '回归测试-重新导出验证'
    })
    resp.raise_for_status()
    reexport_result = resp.json()['data']
    new_doc_no = reexport_result['new_doc_no']
    assert new_doc_no != handover_doc_no
    assert reexport_result['version'] == 2
    assert reexport_result['old_doc_no'] == handover_doc_no
    assert 'correction_summary' in reexport_result
    log_pass(f'重新导出成功: {handover_doc_no} → {new_doc_no}，版本 2')

    print('\n--- 场景9: 验证新单据详情 ---')
    resp = requests.get(f'{BASE_URL}/export/{new_doc_no}')
    resp.raise_for_status()
    new_detail = resp.json()['data']
    assert new_detail['version'] == 2
    assert new_detail['is_reexport'] == 1
    assert new_detail['parent_doc_no'] == handover_doc_no
    assert 'correction_snapshot' in new_detail
    log_pass('新单据详情正确，包含版本信息和快照')

    print('\n--- 场景10: 验证审计日志 ---')
    resp = requests.get(f'{BASE_URL}/audit-logs?action=DOCUMENT_REEXPORT')
    resp.raise_for_status()
    logs = resp.json()['data']
    reexport_logs = [l for l in logs if 'DOCUMENT_REEXPORT' in l['action']]
    assert len(reexport_logs) >= 1
    
    latest_log = reexport_logs[0]
    details = json.loads(latest_log['details']) if isinstance(latest_log['details'], str) else latest_log['details']
    assert details['old_doc_no'] == handover_doc_no
    assert details['new_doc_no'] == new_doc_no
    assert 'reexport_reason' in details
    assert 'correction_summary' in details
    log_pass('审计日志记录完整，包含新旧单据号、原因和更正摘要')

    print('\n--- 场景11: 非 QC 角色重新导出被拒 ---')
    try:
        resp = requests.post(f'{BASE_URL}/export/{handover_doc_no}/reexport', json={
            'operator': '王店长',
            'operator_type': 'STORE',
            'reexport_reason': '测试权限'
        })
        if resp.status_code == 403 and 'QC' in resp.json().get('error', ''):
            log_pass('非 QC 角色重新导出被正确拒绝，返回 403')
        else:
            log_fail(f'非 QC 应该被拒绝，但返回 {resp.status_code}: {resp.json()}')
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 403 and 'QC' in e.response.json().get('error', ''):
            log_pass('非 QC 角色重新导出被正确拒绝，返回 403')
        else:
            raise

    print('\n=== 第三部分: 配置关闭重新导出 ===')
    print()

    print('--- 场景12: 更新配置关闭重新导出 ---')
    resp = requests.post(f'{BASE_URL}/config', json={
        'operator': '系统管理员',
        'version': f'v1.0.0-reexport-off-{int(time.time())}',
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
    log_pass('配置更新成功，allow_reexport=False')

    print('\n--- 场景13: 验证配置生效 ---')
    resp = requests.get(f'{BASE_URL}/config')
    resp.raise_for_status()
    config = resp.json()['data']
    assert config['allow_reexport'] == False
    log_pass('配置接口返回 allow_reexport=False')

    print('\n--- 场景14: QC 重新导出被拒 (配置关闭) ---')
    try:
        resp = requests.post(f'{BASE_URL}/export/{handover_doc_no}/reexport', json={
            'operator': '赵质控',
            'operator_type': 'QC',
            'reexport_reason': '测试配置关闭'
        })
        if resp.status_code == 403 and '关闭' in resp.json().get('error', ''):
            log_pass('配置关闭时 QC 重新导出被正确拒绝，返回 403')
        else:
            log_fail(f'配置关闭时应该被拒绝，但返回 {resp.status_code}: {resp.json()}')
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 403 and '关闭' in e.response.json().get('error', ''):
            log_pass('配置关闭时 QC 重新导出被正确拒绝，返回 403')
        else:
            raise

    print('\n--- 场景15: 验证导出详情和历史在配置关闭后仍可读 ---')
    resp = requests.get(f'{BASE_URL}/export/{handover_doc_no}')
    resp.raise_for_status()
    assert resp.json()['data']['correction_snapshot'] is not None
    
    resp = requests.get(f'{BASE_URL}/export-history?box_no={BOX_NO}')
    resp.raise_for_status()
    assert len(resp.json()['data']) >= 2
    log_pass('配置关闭后，导出详情和历史快照仍可正常读取')

    print('\n========================================')
    print('  ✓ 所有回归测试通过！')
    print('========================================')
    print()
    print('测试数据参考:')
    print(f'  原始交接单: {handover_doc_no}')
    print(f'  重新导出: {new_doc_no}')
    print(f'  异常清单: {exception_doc_no}')
    print()

finally:
    print('  停止服务...', end='', flush=True)
    server_proc.terminate()
    try:
        server_proc.wait(timeout=5)
    except:
        server_proc.kill()
    print(' 已停止')
