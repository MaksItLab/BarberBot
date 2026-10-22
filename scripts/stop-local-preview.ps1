$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$metadataPath = Join-Path $projectRoot 'artifacts/local-preview.json'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts/e2e')) + [IO.Path]::DirectorySeparatorChar
$targetDirectory = [IO.Path]::GetFullPath($metadata.dataDirectory)
if ($metadata.kind -ne 'CosmeticsShopLocalAcceptance' -or $metadata.projectRoot -ne $projectRoot -or -not $targetDirectory.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Preview metadata does not identify this workspace.'
}
$previewProcess = Get-Process -Id $metadata.appPid -ErrorAction SilentlyContinue
if ($null -ne $previewProcess) {
    $recordedStart = if ($metadata.appStartedUtc -is [datetime]) { $metadata.appStartedUtc.ToUniversalTime() }
        else { [DateTimeOffset]::Parse($metadata.appStartedUtc, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
    if ($previewProcess.ProcessName -ne 'dotnet' -or $previewProcess.StartTime.ToUniversalTime().Ticks -ne $recordedStart.Ticks) {
        throw 'The process ID was reused; refusing to stop another process.'
    }
    Stop-Process -Id $previewProcess.Id -Force; $previewProcess.WaitForExit()
}
& (Join-Path $metadata.postgresBin 'pg_ctl.exe') -D $targetDirectory -m fast -w -t 30 stop
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the preview PostgreSQL. Inspect its log.' }
Remove-Item -LiteralPath $metadataPath
Write-Output 'Local preview stopped. Demo database files are preserved.'
