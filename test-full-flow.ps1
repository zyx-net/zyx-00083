$baseUrl = "http://localhost:3000"
$boxNo = "BOX-MAIN-TEST-001"

function Invoke-Api {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [hashtable]$Body = $null
    )
    $url = "$baseUrl$Path"
    Write-Host "`n=== $Method $url ===" -ForegroundColor Cyan
    try {
        $params = @{
            Uri = $url
            Method = $Method
            ContentType = "application/json"
        }
        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Depth 10)
        }
        $response = Invoke-RestMethod @params
        Write-Host ($response | ConvertTo-Json -Depth 10) -ForegroundColor Green
        return $response
    } catch {
        if ($_.Exception.Response) {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $errorBody = $reader.ReadToEnd()
            Write-Host "ERROR: $errorBody" -ForegroundColor Red
        } else {
            Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        }
        return $null
    }
}

Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "  冷链餐盒交付追踪 - 完整验收主链路测试" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow

# 1. 建档
Write-Host "`n[1/9] 餐盒建档" -ForegroundColor Yellow
$createBody = @{
    box_no = $boxNo
    batch_no = "BATCH-MAIN-TEST-001"
    kitchen_staff = "李厨师"
    meal_items = @(
        @{ name = "红烧肉套餐"; quantity = 3; price = 35 },
        @{ name = "时蔬套餐"; quantity = 2; price = 22 }
    )
}
Invoke-Api -Path "/api/boxes" -Method "POST" -Body $createBody

# 2. 出餐
Write-Host "`n[2/9] 出餐" -ForegroundColor Yellow
$mealBody = @{
    operator = "李厨师"
    operator_type = "KITCHEN"
    remark = "餐品制作完成"
}
Invoke-Api -Path "/api/boxes/$boxNo/status/MEAL_PREPARED" -Method "PUT" -Body $mealBody

# 3. 装箱
Write-Host "`n[3/9] 装箱" -ForegroundColor Yellow
$boxBody = @{
    operator = "李厨师"
    operator_type = "KITCHEN"
    remark = "装箱完成，封条编号 SEA-2026-TEST-0001"
}
Invoke-Api -Path "/api/boxes/$boxNo/status/BOXED" -Method "PUT" -Body $boxBody

# 4. 司机接收
Write-Host "`n[4/9] 司机接收" -ForegroundColor Yellow
$driverBody = @{
    operator = "李厨师"
    operator_type = "KITCHEN"
    new_custodian = "张司机"
    new_custodian_type = "DRIVER"
    temperature = 4.2
    remark = "厨房交接给司机"
}
Invoke-Api -Path "/api/boxes/$boxNo/status/DRIVER_RECEIVED" -Method "PUT" -Body $driverBody

# 5. 运输途中温度上报
Write-Host "`n[5/9] 温度上报" -ForegroundColor Yellow
$tempBody = @{
    box_no = $boxNo
    temperature = 5.1
    timestamp = "2026-06-07 13:30:00"
    recorded_by = "张司机"
}
Invoke-Api -Path "/api/temperature" -Method "POST" -Body $tempBody

# 6. 门店验收
Write-Host "`n[6/9] 门店验收" -ForegroundColor Yellow
$storeBody = @{
    operator = "张司机"
    operator_type = "DRIVER"
    new_custodian = "王店长"
    new_custodian_type = "STORE"
    temperature = 4.9
    timestamp = "2026-06-07 14:00:00"
    remark = "门店验收通过，餐品完好"
}
Invoke-Api -Path "/api/boxes/$boxNo/status/STORE_ACCEPTED" -Method "PUT" -Body $storeBody

# 7. 归档
Write-Host "`n[7/9] 归档" -ForegroundColor Yellow
$archiveBody = @{
    operator = "王店长"
    operator_type = "STORE"
    new_custodian = "系统"
    new_custodian_type = "SYSTEM"
    remark = "订单完成归档"
}
Invoke-Api -Path "/api/boxes/$boxNo/status/ARCHIVED" -Method "PUT" -Body $archiveBody

# 8. 导出交接单
Write-Host "`n[8/9] 导出交接单" -ForegroundColor Yellow
$exportBody = @{
    operator = "王店长"
}
Invoke-Api -Path "/api/export/handover/$boxNo" -Method "POST" -Body $exportBody

# 9. 查看最终详情
Write-Host "`n[9/9] 查看最终详情" -ForegroundColor Yellow
Invoke-Api -Path "/api/boxes/$boxNo" -Method "GET"

Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "  主链路测试完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Yellow

Write-Host "`n`n========================================" -ForegroundColor Yellow
Write-Host "  错误场景测试" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow

# 测试1: 重复箱号建档
Write-Host "`n[错误测试1] 重复箱号建档" -ForegroundColor Magenta
$dupBody = @{
    box_no = $boxNo
    batch_no = "BATCH-TEST-DUP"
    kitchen_staff = "李厨师"
    meal_items = @(@{ name = "测试套餐"; quantity = 1 })
}
Invoke-Api -Path "/api/boxes" -Method "POST" -Body $dupBody

# 测试2: 非当前保管人交接
Write-Host "`n[错误测试2] 非当前保管人交接" -ForegroundColor Magenta
$wrongCustBody = @{
    operator = "李厨师"
    operator_type = "KITCHEN"
    new_custodian = "某店长"
    new_custodian_type = "STORE"
    temperature = 4.9
    timestamp = "2026-06-07 14:00:00"
}
Invoke-Api -Path "/api/boxes/$boxNo/status/STORE_ACCEPTED" -Method "PUT" -Body $wrongCustBody

# 测试3: 缺时间戳
Write-Host "`n[错误测试3] 验收缺时间戳 - 先创建新箱测试" -ForegroundColor Magenta
$testBox2 = "BOX-ERR-TEST-001"
$createBody2 = @{
    box_no = $testBox2
    batch_no = "BATCH-ERR-TEST-001"
    kitchen_staff = "王厨师"
    meal_items = @(@{ name = "测试套餐"; quantity = 1 })
}
Invoke-Api -Path "/api/boxes" -Method "POST" -Body $createBody2
Invoke-Api -Path "/api/boxes/$testBox2/status/MEAL_PREPARED" -Method "PUT" -Body @{ operator = "王厨师"; operator_type = "KITCHEN" }
Invoke-Api -Path "/api/boxes/$testBox2/status/BOXED" -Method "PUT" -Body @{ operator = "王厨师"; operator_type = "KITCHEN" }
Invoke-Api -Path "/api/boxes/$testBox2/status/DRIVER_RECEIVED" -Method "PUT" -Body @{ 
    operator = "王厨师"; operator_type = "KITCHEN"
    new_custodian = "赵司机"; new_custodian_type = "DRIVER"
}
$noTsBody = @{
    operator = "赵司机"
    operator_type = "DRIVER"
    new_custodian = "刘店长"
    new_custodian_type = "STORE"
    temperature = 4.9
}
Invoke-Api -Path "/api/boxes/$testBox2/status/STORE_ACCEPTED" -Method "PUT" -Body $noTsBody

# 测试4: 非数字温度
Write-Host "`n[错误测试4] 非数字温度" -ForegroundColor Magenta
$invalidTempBody = @{
    box_no = $testBox2
    temperature = "abc"
    timestamp = "2026-06-07 14:00:00"
    recorded_by = "赵司机"
}
$jsonBody = '{"box_no":"' + $testBox2 + '","temperature":"abc","timestamp":"2026-06-07 14:00:00","recorded_by":"赵司机"}'
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/temperature" -Method "POST" -Body $jsonBody -ContentType "application/json"
    Write-Host ($response | ConvertTo-Json) -ForegroundColor Green
} catch {
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    $errorBody = $reader.ReadToEnd()
    Write-Host "ERROR: $errorBody" -ForegroundColor Red
}

# 测试5: 隔离后继续正常验收
Write-Host "`n[错误测试5] 异常隔离后尝试正常验收" -ForegroundColor Magenta
$testBox3 = "BOX-ISO-TEST-001"
$createBody3 = @{
    box_no = $testBox3
    batch_no = "BATCH-ISO-TEST-001"
    kitchen_staff = "孙厨师"
    meal_items = @(@{ name = "测试套餐"; quantity = 1 })
}
Invoke-Api -Path "/api/boxes" -Method "POST" -Body $createBody3
Invoke-Api -Path "/api/boxes/$testBox3/status/MEAL_PREPARED" -Method "PUT" -Body @{ operator = "孙厨师"; operator_type = "KITCHEN" }
Invoke-Api -Path "/api/boxes/$testBox3/status/BOXED" -Method "PUT" -Body @{ operator = "孙厨师"; operator_type = "KITCHEN" }
Invoke-Api -Path "/api/boxes/$testBox3/status/DRIVER_RECEIVED" -Method "PUT" -Body @{ 
    operator = "孙厨师"; operator_type = "KITCHEN"
    new_custodian = "周司机"; new_custodian_type = "DRIVER"
}
$isoBody = @{
    operator = "周司机"
    operator_type = "DRIVER"
    new_custodian = "郑质控"
    new_custodian_type = "QC"
    exception_reason = "运输途中温度超标"
    remark = "异常隔离处理"
}
Invoke-Api -Path "/api/boxes/$testBox3/status/EXCEPTION_ISOLATED" -Method "PUT" -Body $isoBody

$acceptAfterIsoBody = @{
    operator = "郑质控"
    operator_type = "QC"
    new_custodian = "吴店长"
    new_custodian_type = "STORE"
    temperature = 4.9
    timestamp = "2026-06-07 14:00:00"
}
Invoke-Api -Path "/api/boxes/$testBox3/status/STORE_ACCEPTED" -Method "PUT" -Body $acceptAfterIsoBody

Write-Host "`n========================================" -ForegroundColor Yellow
Write-Host "  所有测试完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Yellow

Write-Host "`n`n=== 数据持久化验证查询 ===" -ForegroundColor Cyan
Write-Host "查询样例餐盒 BOX-SAMPLE-001:" -ForegroundColor Cyan
Invoke-Api -Path "/api/boxes/BOX-SAMPLE-001" -Method "GET"

Write-Host "`n查询配置版本:" -ForegroundColor Cyan
Invoke-Api -Path "/api/configs" -Method "GET"

Write-Host "`n查询审计日志:" -ForegroundColor Cyan
Invoke-Api -Path "/api/audit-logs?box_no=$boxNo" -Method "GET"

Write-Host "`n查询导出历史:" -ForegroundColor Cyan
Invoke-Api -Path "/api/export-history" -Method "GET"
