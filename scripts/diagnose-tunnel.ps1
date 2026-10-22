param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://[a-z0-9-]+\.trycloudflare\.com/?$')]
    [string]$PublicUrl
)

# Read-only checks. No bot credentials, application settings or network changes.
$ErrorActionPreference = 'Stop'
$reportDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\tunnel-diagnostics'
[void](New-Item -ItemType Directory -Path $reportDirectory -Force)
$reportPath = Join-Path $reportDirectory 'latest.txt'
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('Time: ' + [DateTimeOffset]::Now.ToString('o'))
$lines.Add('Public URL: ' + $PublicUrl)

Add-Type -AssemblyName System.Net.Http

function Read-Endpoint([string]$Label, [string]$Address, [bool]$Metrics = $false) {
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($(if ($Metrics) { 2 } else { 10 }))
    $response = $null
    try {
        $response = $client.GetAsync($Address).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if ($Metrics) {
            $matches = [regex]::Matches($body, '(?m)^cloudflared_tunnel_(ha_connections|request_errors|total_requests)(?:\{[^\r\n]*\})? [^\r\n]+')
            if ($matches.Count -eq 0) { return }
            $lines.Add($Label + ': HTTP ' + [int]$response.StatusCode)
            foreach ($entry in $matches) { $lines.Add($entry.Value) }
        }
        else {
            $lines.Add($Label + ': HTTP ' + [int]$response.StatusCode)
            $code = [regex]::Match($body, '(?i)(?:error code:|error\s*)\s*(1033|502|1016)\b')
            if ($code.Success) { $lines.Add('Cloudflare error: ' + $code.Groups[1].Value) }
        }
    }
    catch {
        if (-not $Metrics) { $lines.Add($Label + ': ' + $_.Exception.GetBaseException().Message) }
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
    }
}

try {
    $processes = @(Get-Process -Name 'cloudflared*' -ErrorAction SilentlyContinue)
    $lines.Add('Running cloudflared processes: ' + $processes.Count)
    Read-Endpoint 'Local application' 'http://127.0.0.1:8081/api/health/ready'
    # cloudflared chooses the first available metrics port in this range.
    foreach ($port in 20241..20245) {
        Read-Endpoint ('Tunnel metrics (' + $port + ')') ('http://127.0.0.1:' + $port + '/metrics') $true
    }
    Read-Endpoint 'Public application' $PublicUrl
}
finally {
    $lines | Set-Content -LiteralPath $reportPath -Encoding UTF8
}

$lines | ForEach-Object { Write-Output $_ }
Write-Output ('Report: ' + $reportPath)
