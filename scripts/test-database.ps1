param(
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path $projectRoot ('artifacts/postgres-tests/' + [Guid]::NewGuid().ToString('N'))
$dataDirectory = Join-Path $testRoot 'data'
$passwordFile = Join-Path $testRoot 'password.txt'
$serverLog = Join-Path $testRoot 'postgres.log'
$previousConnection = $env:SHOP_TEST_ADMIN_CONNECTION
$started = $false

foreach ($program in @('initdb.exe', 'pg_ctl.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PostgresBin $program))) {
        throw "PostgreSQL executable not found: $program. Set -PostgresBin to an installed PostgreSQL 18 bin directory."
    }
}

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
[IO.File]::WriteAllText($passwordFile, $password)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

Push-Location $projectRoot
try {
    & (Join-Path $PostgresBin 'initdb.exe') -D $dataDirectory --username=cosmetics_test --pwfile=$passwordFile --auth=scram-sha-256 --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'Test PostgreSQL initialization failed.' }
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $dataDirectory -l $serverLog -o "-h 127.0.0.1 -p $port" -w -t 30 start
    if ($LASTEXITCODE -ne 0) { throw "Test PostgreSQL startup failed. Log: $serverLog" }
    $started = $true
    $env:SHOP_TEST_ADMIN_CONNECTION = "Host=127.0.0.1;Port=$port;Database=postgres;Username=cosmetics_test;Password=$password;Timeout=5"
    dotnet test tests/CosmeticsShop.Api.IntegrationTests --configuration Release --no-restore --maxcpucount:1
    if ($LASTEXITCODE -ne 0) { throw 'Database integration tests failed.' }
} finally {
    $env:SHOP_TEST_ADMIN_CONNECTION = $previousConnection
    if ($started) {
        & (Join-Path $PostgresBin 'pg_ctl.exe') -D $dataDirectory -m fast -w -t 30 stop
        if ($LASTEXITCODE -ne 0) { Write-Warning "Test PostgreSQL did not stop. Inspect $serverLog" }
    }
    if (Test-Path -LiteralPath $passwordFile) { Remove-Item -LiteralPath $passwordFile -Force }
    Pop-Location
}
