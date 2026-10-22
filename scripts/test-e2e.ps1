param(
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$PublishDirectory = 'artifacts/mvp-publish',
    [string]$NodeExecutable = 'node',
    [int]$Port = 0,
    [switch]$KeepRunning
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($KeepRunning -and (Test-Path -LiteralPath (Join-Path $projectRoot 'artifacts/local-preview.json'))) {
    throw 'A local preview is already registered. Stop it with scripts/stop-local-preview.ps1 first.'
}
$runId = [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $projectRoot "artifacts/e2e/$runId"
$dataDirectory = Join-Path $testRoot 'data'
$passwordFile = Join-Path $testRoot 'password.txt'
$publishPath = if ([IO.Path]::IsPathRooted($PublishDirectory)) { $PublishDirectory } else { Join-Path $projectRoot $PublishDirectory }
if (-not (Test-Path -LiteralPath (Join-Path $publishPath 'CosmeticsShop.Api.dll'))) { throw 'Publish the app first: scripts/publish.ps1 -OutputDirectory artifacts/mvp-publish' }
function FreePort([int]$Requested = 0) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Requested)
    $listener.Start(); $result = $listener.LocalEndpoint.Port; $listener.Stop(); return $result
}
$appPort = FreePort $Port
$databasePort = FreePort
$dotnetExecutable = (Get-Command dotnet -ErrorAction Stop).Source
$environmentNames = @('ConnectionStrings__Shop', 'Telegram__BotToken', 'Telegram__Enabled', 'ASPNETCORE_ENVIRONMENT', 'SHOP_UI_URL', 'SHOP_E2E_TOKEN', 'SHOP_E2E_PHASE', 'SHOP_E2E_RUN')
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$started = $false; $success = $false; $applicationProcess = $null
New-Item -ItemType Directory -Force $testRoot | Out-Null
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
[IO.File]::WriteAllText($passwordFile, $password)
function StartApplication {
    $script:applicationProcess = Start-Process -FilePath $dotnetExecutable -ArgumentList @('CosmeticsShop.Api.dll', '--urls', "http://127.0.0.1:$appPort") -WorkingDirectory $publishPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'app.log') -RedirectStandardError (Join-Path $testRoot 'app-error.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($script:applicationProcess.HasExited) { throw "Published application exited. Inspect $testRoot" }
        try { $response = Invoke-WebRequest "http://127.0.0.1:$appPort/api/health/ready" -TimeoutSec 2 -UseBasicParsing; $ready = $response.StatusCode -eq 200 } catch { }
        if ($ready) { break }; Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "Application did not become ready. Inspect $testRoot" }
}
Push-Location $projectRoot
try {
    & (Join-Path $PostgresBin 'initdb.exe') -D $dataDirectory --username=cosmetics_e2e --pwfile=$passwordFile --auth=scram-sha-256 --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'E2E database initialization failed.' }
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $dataDirectory -l (Join-Path $testRoot 'postgres.log') -o "-h 127.0.0.1 -p $databasePort" -w -t 30 start
    if ($LASTEXITCODE -ne 0) { throw 'E2E database startup failed.' }; $started = $true
    $env:ConnectionStrings__Shop = "Host=127.0.0.1;Port=$databasePort;Database=postgres;Username=cosmetics_e2e;Password=$password;Timeout=3"
    $env:ASPNETCORE_ENVIRONMENT = 'Development'; $env:Telegram__Enabled = 'false'
    $env:Telegram__BotToken = '123456:' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    $env:SHOP_E2E_TOKEN = $env:Telegram__BotToken
    $env:SHOP_UI_URL = "http://127.0.0.1:$appPort"; $env:SHOP_E2E_RUN = $runId
    dotnet ef database update --project backend/CosmeticsShop.Infrastructure --startup-project backend/CosmeticsShop.Api --configuration Release --no-build
    if ($LASTEXITCODE -ne 0) { throw 'E2E migrations failed.' }
    Push-Location $publishPath
    try { & $dotnetExecutable CosmeticsShop.Api.dll --grant-admin 9000000001; if ($LASTEXITCODE -ne 0) { throw 'E2E administrator setup failed.' } } finally { Pop-Location }
    StartApplication
    $env:SHOP_E2E_PHASE = 'create'
    & $NodeExecutable tests/frontend/e2e.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Full browser acceptance failed.' }
    Stop-Process -Id $applicationProcess.Id -Force; $applicationProcess.WaitForExit(); $applicationProcess = $null
    StartApplication
    $env:SHOP_E2E_PHASE = 'verify'
    & $NodeExecutable tests/frontend/e2e.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Persistence after restart failed.' }
    $success = $true
    if ($KeepRunning) {
        @{ kind = 'CosmeticsShopLocalAcceptance'; projectRoot = $projectRoot; dataDirectory = $dataDirectory; postgresBin = $PostgresBin;
           appPid = $applicationProcess.Id; appStartedUtc = $applicationProcess.StartTime.ToUniversalTime().ToString('O'); url = $env:SHOP_UI_URL } |
            ConvertTo-Json | Set-Content (Join-Path $projectRoot 'artifacts/local-preview.json')
        Write-Output "Local demo is running at $env:SHOP_UI_URL. Stop it with scripts/stop-local-preview.ps1."
    } else { Write-Output 'PASS: published frontend/API/PostgreSQL acceptance and persistence after restart.' }
} finally {
    if (-not ($KeepRunning -and $success)) {
        if ($null -ne $applicationProcess -and -not $applicationProcess.HasExited) { Stop-Process -Id $applicationProcess.Id -Force; $applicationProcess.WaitForExit() }
        if ($started) { & (Join-Path $PostgresBin 'pg_ctl.exe') -D $dataDirectory -m fast -w -t 30 stop | Out-Null }
    }
    if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force }
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    Pop-Location
}
