[CmdletBinding()]
param(
    [switch]$Describe,
    [switch]$ProbeOnly,
    [switch]$NoBrowser,
    [ValidateRange(1, 300)]
    [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$adminScript = Join-Path $repositoryRoot 'scripts\admin-server.js'

$portText = $env:PORT
if ([string]::IsNullOrWhiteSpace($portText)) {
    $port = 3000
} else {
    $parsedPort = 0
    if (-not [int]::TryParse($portText, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
        [Console]::Error.WriteLine('PORT must be an integer from 1 through 65535.')
        exit 2
    }
    $port = $parsedPort
}

$adminUrl = "http://127.0.0.1:$port/"
$description = [ordered]@{
    repositoryRoot = $repositoryRoot
    adminScript = $adminScript
    port = $port
    adminUrl = $adminUrl
}

if ($Describe) {
    $description | ConvertTo-Json -Compress
    exit 0
}

function Test-AdminEndpoint {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Wait-ForAdminEndpoint {
    param(
        [string]$Url,
        [int]$TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-AdminEndpoint -Url $Url) {
            return $true
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

if (Test-AdminEndpoint -Url $adminUrl) {
    Write-Output "already-running $adminUrl"
    if (-not $NoBrowser -and -not $ProbeOnly) {
        Start-Process $adminUrl
    }
    exit 0
}

if ($ProbeOnly) {
    if (Wait-ForAdminEndpoint -Url $adminUrl -TimeoutSeconds $StartupTimeoutSeconds) {
        Write-Output "already-running $adminUrl"
        exit 0
    }
    [Console]::Error.WriteLine("Automoney server did not respond within $StartupTimeoutSeconds seconds.")
    exit 1
}

if (-not (Test-Path -LiteralPath $adminScript -PathType Leaf)) {
    [Console]::Error.WriteLine('Automoney admin server script was not found.')
    exit 2
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    [Console]::Error.WriteLine('Node.js를 찾을 수 없습니다. Node.js 24 이상을 설치하세요.')
    exit 2
}

Push-Location $repositoryRoot
$serverProcess = $null
try {
    Write-Output "Automoney 서버를 시작합니다: $adminUrl"
    $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @($adminScript) -NoNewWindow -PassThru

    if (-not (Wait-ForAdminEndpoint -Url $adminUrl -TimeoutSeconds $StartupTimeoutSeconds)) {
        [Console]::Error.WriteLine("서버가 $StartupTimeoutSeconds 초 안에 준비되지 않았습니다.")
        if (-not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id
        }
        exit 1
    }

    Write-Output "Automoney 준비 완료: $adminUrl"
    if (-not $NoBrowser) {
        Start-Process $adminUrl
    }

    Wait-Process -Id $serverProcess.Id
    exit $serverProcess.ExitCode
} finally {
    if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id
    }
    Pop-Location
}
