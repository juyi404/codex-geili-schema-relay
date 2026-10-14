$ErrorActionPreference = 'Stop'
$taskRelayDirectory = $PSScriptRoot
$taskRelayUrl = 'http://127.0.0.1:18766/health'
try {
    $taskHealth = Invoke-RestMethod -Uri $taskRelayUrl -TimeoutSec 2
    if ($taskHealth.service -eq 'codex-geili-schema-relay') { exit 0 }
    throw 'The relay port is occupied by another service.'
} catch {
    if (Get-NetTCPConnection -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue) { throw }
}
$taskNodePath = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $taskNodePath)) { throw 'Node.js runtime is missing.' }
$taskProcess = Start-Process -FilePath $taskNodePath -ArgumentList @('"' + (Join-Path $taskRelayDirectory 'relay.mjs') + '"') -WorkingDirectory $taskRelayDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRelayDirectory 'relay.log') -RedirectStandardError (Join-Path $taskRelayDirectory 'relay-error.log')
for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
    Start-Sleep -Milliseconds 150
    if ($taskProcess.HasExited) { throw 'Codex schema relay exited during startup.' }
    try {
        $taskHealth = Invoke-RestMethod -Uri $taskRelayUrl -TimeoutSec 1
        if ($taskHealth.service -eq 'codex-geili-schema-relay') { exit 0 }
    } catch {}
}
throw 'Codex schema relay did not become ready.'
