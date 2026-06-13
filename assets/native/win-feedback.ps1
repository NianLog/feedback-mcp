# feedback-mcp native Windows 对话框（WinForms 多行输入 + 超时）
#
# 由 backends/native-backend.ts 通过 powershell.exe -File 调用。
# stdout 输出单行 JSON：{"status":"submitted|cancelled|timeout","response":"..."}
# - submitted：用户点 Submit，response 为输入内容（支持多行）
# - cancelled：用户点 Cancel 或关闭窗口
# - timeout：到达 -Timeout 秒未操作，自动关闭
#
# 注意：使用 -ExecutionPolicy Bypass 调用以绕过执行策略限制。

param(
    [string]$Message = "",
    [int]$Timeout = 300
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- 主窗体 ----
$form = New-Object System.Windows.Forms.Form
$form.Text = "Interactive Feedback"
$form.Size = New-Object System.Drawing.Size(580, 500)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

# ---- 消息展示区（只读，自动换行）----
$lblMessage = New-Object System.Windows.Forms.Label
$lblMessage.Text = $Message
$lblMessage.Location = New-Object System.Drawing.Point(15, 15)
$lblMessage.Size = New-Object System.Drawing.Size(535, 230)
$lblMessage.AutoSize = $false

# ---- 用户输入区（多行 TextBox）----
$txtResponse = New-Object System.Windows.Forms.TextBox
$txtResponse.Multiline = $true
$txtResponse.Location = New-Object System.Drawing.Point(15, 255)
$txtResponse.Size = New-Object System.Drawing.Size(535, 150)
$txtResponse.ScrollBars = "Vertical"
$txtResponse.AcceptsReturn = $true
$txtResponse.WordWrap = $true

# ---- Submit 按钮 ----
$btnSubmit = New-Object System.Windows.Forms.Button
$btnSubmit.Text = "Submit"
$btnSubmit.Location = New-Object System.Drawing.Point(335, 415)
$btnSubmit.Size = New-Object System.Drawing.Size(100, 32)
$btnSubmit.DialogResult = [System.Windows.Forms.DialogResult]::OK

# ---- Cancel 按钮 ----
$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = "Cancel"
$btnCancel.Location = New-Object System.Drawing.Point(450, 415)
$btnCancel.Size = New-Object System.Drawing.Size(100, 32)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

$form.Controls.AddRange(@($lblMessage, $txtResponse, $btnSubmit, $btnCancel))
$form.AcceptButton = $btnSubmit
$form.CancelButton = $btnCancel

# ---- 状态对象（用 Form.Tag 携带，Timer 回调可安全修改）----
$form.Tag = [PSCustomObject]@{ status = "cancelled"; response = "" }

# ---- 超时定时器 ----
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Timeout * 1000
$timer.Add_Tick({
    $form.Tag.status = "timeout"
    $form.Close()
})
$timer.Start()

# ---- 显示对话框（阻塞）----
$dialogResult = $form.ShowDialog()
$timer.Stop()

# ---- 确定最终状态 ----
if ($form.Tag.status -ne "timeout" -and $dialogResult -eq [System.Windows.Forms.DialogResult]::OK) {
    $form.Tag.status = "submitted"
}
$form.Tag.response = $txtResponse.Text

# ---- 输出 JSON 到 stdout（单行，紧凑）----
Write-Output ($form.Tag | ConvertTo-Json -Compress)
