# feedback-mcp native Windows dialog (WinForms multiline input + timeout)
#
# Called by backends/native-backend.ts via:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File win-feedback.ps1 -Timeout <sec>
#
# Input : message text is read from STDIN as UTF-8 (avoids the ~32K command-line
#         length limit and codepage issues of passing text via -Message argv).
# Output: ONE line on stdout ->  B64:<base64 of UTF-8 JSON {"status":"...","response":"..."}>
#         The Base64 envelope is codepage-proof: Windows PowerShell writes redirected
#         output using the legacy OEM/ANSI codepage, which corrupts raw UTF-8 JSON
#         on non-English systems (e.g. CP936 on zh-CN Windows).
#         status: submitted | cancelled | timeout
#
# Note : -ExecutionPolicy Bypass is used by the caller to run this script.

param(
    [int]$Timeout = 300
)

$ErrorActionPreference = 'Stop'

# ---- read message from stdin (UTF-8, BOM-tolerant) ----
$Message = ''
try {
    $stdinReader = New-Object System.IO.StreamReader(
        [Console]::OpenStandardInput(),
        (New-Object System.Text.UTF8Encoding($false))
    )
    $Message = $stdinReader.ReadToEnd()
} catch {
    $Message = ''
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- main form ----
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Interactive Feedback'
$form.Size = New-Object System.Drawing.Size(600, 520)
$form.MinimumSize = New-Object System.Drawing.Size(420, 380)
$form.StartPosition = 'CenterScreen'
$form.KeyPreview = $true

# ---- message area (read-only, scrollable, wraps long text) ----
$txtMessage = New-Object System.Windows.Forms.TextBox
$txtMessage.ReadOnly = $true
$txtMessage.Multiline = $true
$txtMessage.ScrollBars = 'Vertical'
$txtMessage.WordWrap = $true
$txtMessage.TabStop = $false
$txtMessage.Location = New-Object System.Drawing.Point(12, 12)
$txtMessage.Size = New-Object System.Drawing.Size(560, 240)
$txtMessage.Anchor = 'Top,Left,Right'
$txtMessage.BackColor = [System.Drawing.SystemColors]::Window
$txtMessage.Text = $Message

# ---- response area (multiline TextBox) ----
$lblInput = New-Object System.Windows.Forms.Label
$lblInput.Text = 'Your response:'
$lblInput.AutoSize = $true
$lblInput.Location = New-Object System.Drawing.Point(12, 260)
$lblInput.Anchor = 'Top,Left,Right'

$txtResponse = New-Object System.Windows.Forms.TextBox
$txtResponse.Multiline = $true
$txtResponse.Location = New-Object System.Drawing.Point(12, 278)
$txtResponse.Size = New-Object System.Drawing.Size(560, 140)
$txtResponse.ScrollBars = 'Vertical'
$txtResponse.AcceptsReturn = $true
$txtResponse.WordWrap = $true
$txtResponse.MaxLength = 0
$txtResponse.Anchor = 'Top,Left,Right,Bottom'

# ---- Submit / Cancel buttons ----
$btnSubmit = New-Object System.Windows.Forms.Button
$btnSubmit.Text = 'Submit'
$btnSubmit.Location = New-Object System.Drawing.Point(378, 428)
$btnSubmit.Size = New-Object System.Drawing.Size(95, 30)
$btnSubmit.DialogResult = [System.Windows.Forms.DialogResult]::OK
$btnSubmit.Anchor = 'Bottom,Right'

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = 'Cancel'
$btnCancel.Location = New-Object System.Drawing.Point(479, 428)
$btnCancel.Size = New-Object System.Drawing.Size(95, 30)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$btnCancel.Anchor = 'Bottom,Right'

$form.Controls.AddRange(@($txtMessage, $lblInput, $txtResponse, $btnSubmit, $btnCancel))
$form.AcceptButton = $btnSubmit
$form.CancelButton = $btnCancel

# ---- state object (Form.Tag carried, safe to mutate from Timer callback) ----
$form.Tag = [PSCustomObject]@{ status = 'cancelled' }

# ---- timeout timer ----
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Timeout * 1000
$timer.Add_Tick({
    $form.Tag.status = 'timeout'
    $form.Close()
})
$timer.Start()

# ---- keyboard: Ctrl+Enter submits (Esc is handled by CancelButton) ----
$form.Add_KeyDown({
    if ($_.Control -and $_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    }
})

# ---- show dialog (blocking) ----
$dialogResult = $form.ShowDialog()
$timer.Stop()

# ---- resolve final status ----
if ($form.Tag.status -ne 'timeout' -and $dialogResult -eq [System.Windows.Forms.DialogResult]::OK) {
    $form.Tag.status = 'submitted'
}

$response = $txtResponse.Text
# keep in sync with server-side MAX_RESPONSE_CHARS
if ($response.Length -gt 1000000) {
    $response = $response.Substring(0, 1000000)
}
$form.Tag | Add-Member -MemberType NoteProperty -Name response -Value $response -Force

# ---- emit single-line Base64-wrapped JSON to stdout ----
$payload = $form.Tag | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
[Console]::Out.Write('B64:' + [Convert]::ToBase64String($bytes) + [Environment]::NewLine)

$form.Dispose()
