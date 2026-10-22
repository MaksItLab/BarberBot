param([string]$OutputDirectory = 'artifacts/publish')

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publishDirectory = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $projectRoot $OutputDirectory }

Push-Location $projectRoot
try {
    pnpm --dir frontend install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    pnpm --dir frontend build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    dotnet restore CosmeticsShop.slnx --locked-mode
    if ($LASTEXITCODE -ne 0) { throw 'Backend restore failed.' }
    dotnet publish backend/CosmeticsShop.Api -c Release --no-restore -o $publishDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Backend publish failed.' }

    $webRoot = Join-Path $publishDirectory 'wwwroot'
    New-Item -ItemType Directory -Path $webRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $projectRoot 'frontend/dist/*') -Destination $webRoot -Recurse -Force
    Write-Output "Published frontend and backend to $publishDirectory"
} finally {
    Pop-Location
}
