$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runDirectory = Join-Path $projectRoot 'artifacts/local-tunnel'
$state = Get-Content -LiteralPath (Join-Path $runDirectory 'state.json') -Raw | ConvertFrom-Json
if ($state.kind -ne 'CosmeticsShopTunnelSupervisor' -or $state.projectRoot -ne $projectRoot) {
    throw 'Unexpected tunnel metadata.'
}
# Request graceful shutdown through a workspace-only file. Never kill a reused PID.
[IO.File]::WriteAllText((Join-Path $runDirectory 'stop'), 'stop')
for ($attempt=0; $attempt -lt 20; $attempt++) {
    $supervisor = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if ($null -eq $supervisor) { Write-Output 'Local tunnel supervisor stopped.'; return }
    Start-Sleep -Milliseconds 500
}
throw 'Shutdown was requested. Inspect the tunnel log if the process is still running.'
