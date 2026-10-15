# 在 Windows 工作排程器登記「每天一次」的國泰查詢（node run.js），或登記「登入時啟動」的監看模式（node run.js --watch）。
# 用法（在這個資料夾按右鍵 → 在終端機開啟，或 PowerShell）：
#   .\schedule-windows.ps1                 每天 07:30 查一輪
#   .\schedule-windows.ps1 -At 21:00       每天 21:00 查一輪
#   .\schedule-windows.ps1 -Watch          登入 Windows 時自動開始監看模式（建議）
#   .\schedule-windows.ps1 -Remove         取消登記
# 第一次若出現「無法載入指令碼」，先執行：Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
param(
  [string]$At = "07:30",
  [switch]$Watch,
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$name = "award-search cathay-runner"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "找不到 node，請先安裝 Node.js（https://nodejs.org）再執行。"; exit 1 }

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已取消「$name」。"
  exit 0
}

if ($Watch) {
  # 監看模式：開一個終端機視窗一直跑著（看得到登入提示）。
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/k `"$node`" run.js --watch" -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $what = "登入 Windows 時開始監看模式"
} else {
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$node`" run.js" -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  $what = "每天 $At 查一輪"
}
# 一定要「只在使用者登入時執行」（互動式），瀏覽器視窗才看得到、需要登入時才能按 Enter。
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 23)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "已登記「$name」：$what（資料夾 $dir）。"
Write-Host "要改時間就再執行一次；要取消：.\schedule-windows.ps1 -Remove"
