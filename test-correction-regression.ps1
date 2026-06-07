# 冷链餐盒交接更正功能 - 回归测试脚本 (Windows PowerShell版本)
# 使用方法: .\test-correction-regression.ps1

$baseUrl = "http://localhost:3000"
$testBoxPrefix = "BOX-REG-TEST-PS"
$testBatchPrefix = "BATCH-REG-TEST-PS"

$passCount = 0
$failCount = 0

function Invoke-Api {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null,
        [bool]$ExpectedSuccess = $true
    )
    
    $url = "$baseUrl$Path"
    try {
        $params = @{
            Uri = $url
            Method = $Method
        }
        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Depth 10)
            $params.ContentType = "application/json"
        }
        $response = Invoke-RestMethod @params
        if ($ExpectedSuccess -and $response.success) {
            $script:passCount++
        } elseif (-not $ExpectedSuccess -and -not $response.success) {
            $script:passCount++
        } else {
            $script:failCount++
        }
        return $response
    } catch {
        if (-not $ExpectedSuccess -and $_.Exception.Response) {
            $script:passCount++
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $responseBody = $reader.ReadToEnd()
            return ($responseBody | ConvertFrom-Json)
        }
        $script:failCount++
        return @{ error = $_.Exception.Message }
    }
}

function Write-TestHeader {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=" * 70)
    Write-Host "  $Title"
    Write-Host ("=" * 70)
}

function Write-TestResult {
    param(
        [string]$TestName,
        [bool]$Success,
        [string]$Details = ""
    )
    $status = if ($Success) { "✓ PASS" } else { "✗ FAIL" }
    Write-Host "  $status  $TestName"
    if ($Details) {
        Write-Host "         $Details"
    }
}

function Run-Tests {
    Write-Host ""
    Write-Host ("=" * 70)
    Write-Host "  冷链餐盒交接更正功能 - 回归测试套件 (PowerShell版本)"
    Write-Host ("=" * 70)
    Write-Host "  测试时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Host "  服务地址: $baseUrl"

    Write-TestHeader "第一部分: 权限控制测试"
    Test-Permissions

    Write-TestHeader "第二部分: 冲突检测测试"
    Test-ConflictDetection

    Write-TestHeader "第三部分: 导出功能测试（含更正状态）"
    Test-ExportWithCorrections

    Write-TestHeader "测试总结"
    Write-Host ""
    Write-Host "  总测试数: $($passCount + $failCount)"
    Write-Host "  通过: $passCount"
    Write-Host "  失败: $failCount"
    $passRate = [math]::Round(($passCount / ($passCount + $failCount)) * 100, 2)
    Write-Host "  通过率: $passRate%"
    Write-Host ""
    Write-Host ("=" * 70)

    if ($failCount -gt 0) {
        exit 1
    } else {
        exit 0
    }
}

function Test-Permissions {
    $testId = Get-Date -Format 'yyyyMMddHHmmss'
    $boxNo = "$testBoxPrefix-PERM-$testId"
    $batchNo = "$testBatchPrefix-PERM-$testId"

    Write-Host ""
    Write-Host "  前置准备: 创建测试餐盒并流转到司机接收状态"
    
    Invoke-Api -Path "/api/boxes" -Method "POST" -Body @{
        box_no = $boxNo
        batch_no = $batchNo
        kitchen_staff = "李厨师"
        meal_items = @(@{ name = "测试套餐"; quantity = 1 })
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo/status/MEAL_PREPARED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo/status/BOXED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo/status/DRIVER_RECEIVED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
        new_custodian = "王司机"
        new_custodian_type = "DRIVER"
        temperature = 4.5
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/temperature" -Method "POST" -Body @{
        box_no = $boxNo
        temperature = 5.0
        timestamp = "2026-06-07 13:00:00"
        recorded_by = "王司机"
    } -ExpectedSuccess $true | Out-Null

    $boxDetail = Invoke-Api -Path "/api/boxes/$boxNo" -Method "GET" -ExpectedSuccess $true
    $tempRecordId = $boxDetail.data.temperature_readings[0].id
    $statusRecordId = $boxDetail.data.status_history[3].id

    Write-Host ""
    Write-Host "  测试1: SYSTEM角色不能提交更正申请"
    $result1 = Invoke-Api -Path "/api/corrections" -Method "POST" -Body @{
        box_no = $boxNo
        record_type = "temperature"
        record_id = $tempRecordId
        field_name = "temperature"
        proposed_value = "4.8"
        apply_reason = "测试"
        applicant = "系统"
        applicant_type = "SYSTEM"
    } -ExpectedSuccess $false
    Write-TestResult "SYSTEM角色提交更正被拒绝" (-not $result1.success) $result1.error

    Write-Host ""
    Write-Host "  测试2: DRIVER角色可以提交更正申请"
    $result2 = Invoke-Api -Path "/api/corrections" -Method "POST" -Body @{
        box_no = $boxNo
        record_type = "temperature"
        record_id = $tempRecordId
        field_name = "temperature"
        proposed_value = "4.8"
        apply_reason = "温度读数误差"
        applicant = "王司机"
        applicant_type = "DRIVER"
    } -ExpectedSuccess $true
    Write-TestResult "DRIVER角色提交更正成功" $result2.success "更正编号: $($result2.data.correction_no)"
    $correctionId1 = $result2.data.id

    Write-Host ""
    Write-Host "  测试3: STORE角色可以提交更正申请"
    $result3 = Invoke-Api -Path "/api/corrections" -Method "POST" -Body @{
        box_no = $boxNo
        record_type = "status_history"
        record_id = $statusRecordId
        field_name = "operator"
        proposed_value = "张司机"
        apply_reason = "操作人填写错误"
        applicant = "李店长"
        applicant_type = "STORE"
    } -ExpectedSuccess $true
    Write-TestResult "STORE角色提交更正成功" $result3.success "更正编号: $($result3.data.correction_no)"
    $correctionId2 = $result3.data.id

    Write-Host ""
    Write-Host "  测试4: DRIVER角色不能审核更正申请"
    $result4 = Invoke-Api -Path "/api/corrections/$correctionId1/review" -Method "PUT" -Body @{
        reviewer = "王司机"
        reviewer_type = "DRIVER"
        review_result = "APPROVED"
        review_reason = "同意"
    } -ExpectedSuccess $false
    Write-TestResult "DRIVER角色审核被拒绝" (-not $result4.success) $result4.error

    Write-Host ""
    Write-Host "  测试5: QC角色可以审核更正申请（通过）"
    $result5 = Invoke-Api -Path "/api/corrections/$correctionId1/review" -Method "PUT" -Body @{
        reviewer = "赵质控"
        reviewer_type = "QC"
        review_result = "APPROVED"
        review_reason = "经核实，同意更正"
    } -ExpectedSuccess $true
    Write-TestResult "QC角色审核通过成功" $result5.success "状态: $($result5.data.status_label)"

    Write-Host ""
    Write-Host "  测试6: QC角色可以审核更正申请（驳回）"
    $result6 = Invoke-Api -Path "/api/corrections/$correctionId2/review" -Method "PUT" -Body @{
        reviewer = "赵质控"
        reviewer_type = "QC"
        review_result = "REJECTED"
        review_reason = "证据不足，驳回申请"
    } -ExpectedSuccess $true
    Write-TestResult "QC角色审核驳回成功" $result6.success "状态: $($result6.data.status_label)"

    Write-Host ""
    Write-Host "  测试7: 验证更正后的值已生效"
    $boxAfter = Invoke-Api -Path "/api/boxes/$boxNo" -Method "GET" -ExpectedSuccess $true
    $correctedTemp = $boxAfter.data.temperature_readings[0].temperature
    Write-TestResult "温度值已更正为4.8" ($correctedTemp -eq 4.8) "原值: 5.0, 现值: $correctedTemp"
}

function Test-ConflictDetection {
    $testId = Get-Date -Format 'yyyyMMddHHmmss'
    $boxNo1 = "$testBoxPrefix-CON-$testId-1"
    $boxNo2 = "$testBoxPrefix-CON-$testId-2"
    $batchNo = "$testBatchPrefix-CON-$testId"

    Write-Host ""
    Write-Host "  前置准备: 创建同一批次的两个测试餐盒"
    
    Invoke-Api -Path "/api/boxes" -Method "POST" -Body @{
        box_no = $boxNo1
        batch_no = $batchNo
        kitchen_staff = "李厨师"
        meal_items = @(@{ name = "测试套餐"; quantity = 1 })
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo1/status/MEAL_PREPARED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo1/status/BOXED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo1/status/DRIVER_RECEIVED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
        new_custodian = "王司机"
        new_custodian_type = "DRIVER"
        temperature = 4.5
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/temperature" -Method "POST" -Body @{
        box_no = $boxNo1
        temperature = 5.0
        timestamp = "2026-06-07 13:00:00"
        recorded_by = "王司机"
    } -ExpectedSuccess $true | Out-Null

    $boxDetail = Invoke-Api -Path "/api/boxes/$boxNo1" -Method "GET" -ExpectedSuccess $true
    $tempRecordId = $boxDetail.data.temperature_readings[0].id

    Write-Host ""
    Write-Host "  测试1: 第一条更正申请 - 无冲突"
    $result1 = Invoke-Api -Path "/api/corrections" -Method "POST" -Body @{
        box_no = $boxNo1
        record_type = "temperature"
        record_id = $tempRecordId
        field_name = "temperature"
        proposed_value = "4.8"
        apply_reason = "温度读数误差"
        applicant = "王司机"
        applicant_type = "DRIVER"
    } -ExpectedSuccess $true
    Write-TestResult "第一条更正提交成功（无冲突）" ($result1.success -and $result1.data.conflict_warning -eq 0) `
        "conflict_warning: $($result1.data.conflict_warning)"
    $correctionId1 = $result1.data.id

    Write-Host ""
    Write-Host "  测试2: 第二条更正申请（同批次）- 应检测到冲突"
    $result2 = Invoke-Api -Path "/api/corrections" -Method "POST" -Body @{
        box_no = $boxNo1
        record_type = "box"
        field_name = "current_custodian"
        proposed_value = "李司机"
        apply_reason = "保管人错误"
        applicant = "李店长"
        applicant_type = "STORE"
    } -ExpectedSuccess $true
    Write-TestResult "第二条更正提交成功（检测到冲突）" ($result2.success -and $result2.data.conflict_warning -eq 1) `
        "conflict_warning: $($result2.data.conflict_warning), has_active_conflicts: $($result2.data.has_active_conflicts)"
    $correctionId2 = $result2.data.id

    Write-Host ""
    Write-Host "  测试3: 批次状态查询 - 应显示冲突"
    $batchStatus = Invoke-Api -Path "/api/corrections/batch/$batchNo/status" -Method "GET" -ExpectedSuccess $true
    Write-TestResult "批次状态显示冲突" ($batchStatus.success -and $batchStatus.data.has_conflicts -eq $true) `
        "pending_count: $($batchStatus.data.pending_count), has_conflicts: $($batchStatus.data.has_conflicts)"

    Write-Host ""
    Write-Host "  测试4: 审核第一条更正通过 - 验证冲突标记"
    $result4 = Invoke-Api -Path "/api/corrections/$correctionId1/review" -Method "PUT" -Body @{
        reviewer = "赵质控"
        reviewer_type = "QC"
        review_result = "APPROVED"
        review_reason = "同意更正"
    } -ExpectedSuccess $true
    Write-TestResult "第一条更正审核通过" $result4.success `
        "has_active_conflicts: $($result4.data.has_active_conflicts)"
}

function Test-ExportWithCorrections {
    $testId = Get-Date -Format 'yyyyMMddHHmmss'
    $boxNo = "$testBoxPrefix-EXP-$testId"
    $batchNo = "$testBatchPrefix-EXP-$testId"

    Write-Host ""
    Write-Host "  前置准备: 创建测试餐盒并设置为异常隔离"
    
    Invoke-Api -Path "/api/boxes" -Method "POST" -Body @{
        box_no = $boxNo
        batch_no = $batchNo
        kitchen_staff = "李厨师"
        meal_items = @(@{ name = "测试套餐"; quantity = 1 })
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo/status/MEAL_PREPARED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo/status/BOXED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo/status/DRIVER_RECEIVED" -Method "PUT" -Body @{
        operator = "李厨师"
        operator_type = "KITCHEN"
        new_custodian = "王司机"
        new_custodian_type = "DRIVER"
        temperature = 4.5
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/temperature" -Method "POST" -Body @{
        box_no = $boxNo
        temperature = 15.0
        timestamp = "2026-06-07 13:00:00"
        recorded_by = "王司机"
    } -ExpectedSuccess $true | Out-Null

    Invoke-Api -Path "/api/boxes/$boxNo/status/EXCEPTION_ISOLATED" -Method "PUT" -Body @{
        operator = "王司机"
        operator_type = "DRIVER"
        new_custodian = "赵质控"
        new_custodian_type = "QC"
        exception_reason = "温度超标"
    } -ExpectedSuccess $true | Out-Null

    $boxDetail = Invoke-Api -Path "/api/boxes/$boxNo" -Method "GET" -ExpectedSuccess $true
    $tempRecordId = $boxDetail.data.temperature_readings[0].id

    Write-Host ""
    Write-Host "  测试1: 导出异常清单（无更正时）"
    $export1 = Invoke-Api -Path "/api/export/exceptions" -Method "POST" -Body @{
        operator = "赵质控"
    } -ExpectedSuccess $true
    $exception1 = $export1.data.exceptions | Where-Object { $_.box_no -eq $boxNo }
    Write-TestResult "导出包含异常餐盒" ($null -ne $exception1) "找到异常餐盒: $($exception1.box_no)"
    Write-TestResult "无更正时correction_status字段存在" ($null -ne $exception1.correction_status) `
        "correction_status存在: $($null -ne $exception1.correction_status)"
    Write-TestResult "无更正时pending_count为0" ($exception1.correction_status.pending_count -eq 0) `
        "pending_count: $($exception1.correction_status.pending_count)"

    Write-Host ""
    Write-Host "  测试2: 提交更正申请后导出（待审核状态）"
    Invoke-Api -Path "/api/corrections" -Method "POST" -Body @{
        box_no = $boxNo
        record_type = "temperature"
        record_id = $tempRecordId
        field_name = "temperature"
        proposed_value = "4.8"
        apply_reason = "温度单位错误"
        applicant = "王司机"
        applicant_type = "DRIVER"
    } -ExpectedSuccess $true | Out-Null

    $export2 = Invoke-Api -Path "/api/export/exceptions" -Method "POST" -Body @{
        operator = "赵质控"
    } -ExpectedSuccess $true
    $exception2 = $export2.data.exceptions | Where-Object { $_.box_no -eq $boxNo }
    Write-TestResult "待审更正状态正确" ($exception2.correction_status.pending_count -eq 1) `
        "pending_count: $($exception2.correction_status.pending_count)"
}

Run-Tests
