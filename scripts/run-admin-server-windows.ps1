[CmdletBinding()]
param(
    [switch]$Describe,
    [switch]$ProbeOnly,
    [switch]$NoBrowser,
    [ValidateRange(1, 300)]
    [int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

function ConvertFrom-CodePoints {
    param([int[]]$CodePoints)
    return -join ($CodePoints | ForEach-Object { [char]$_ })
}

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
    $notFound = ConvertFrom-CodePoints @(0xC2E4,0xD589,0xAE30,0x20,0xD30C,0xC77C,0xC744,0x20,0xCC3E,0xC744,0x20,0xC218,0x20,0xC5C6,0xC2B5,0xB2C8,0xB2E4)
    [Console]::Error.WriteLine("Automoney $notFound.")
    exit 2
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    $nodeMissing = ConvertFrom-CodePoints @(0x4E,0x6F,0x64,0x65,0x2E,0x6A,0x73,0xB97C,0x20,0xCC3E,0xC744,0x20,0xC218,0x20,0xC5C6,0xC2B5,0xB2C8,0xB2E4,0x2E,0x20,0x4E,0x6F,0x64,0x65,0x2E,0x6A,0x73,0x20,0x32,0x34,0x20,0xC774,0xC0C1,0xC744,0x20,0xC124,0xCE58,0xD558,0xC138,0xC694,0x2E)
    [Console]::Error.WriteLine($nodeMissing)
    exit 2
}

Push-Location $repositoryRoot
$serverProcess = $null
try {
    $starting = ConvertFrom-CodePoints @(0xC11C,0xBC84,0xB97C,0x20,0xC2DC,0xC791,0xD569,0xB2C8,0xB2E4)
    Write-Output "Automoney $starting`: $adminUrl"
    $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @($adminScript) -NoNewWindow -PassThru

    if (-not (Wait-ForAdminEndpoint -Url $adminUrl -TimeoutSeconds $StartupTimeoutSeconds)) {
        $notReady = ConvertFrom-CodePoints @(0xC11C,0xBC84,0xAC00,0x20,0xC2DC,0xAC04,0x20,0xC548,0xC5D0,0x20,0xC900,0xBE44,0xB418,0xC9C0,0x20,0xC54A,0xC558,0xC2B5,0xB2C8,0xB2E4)
        [Console]::Error.WriteLine("$notReady ($StartupTimeoutSeconds seconds).")
        if (-not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id
        }
        exit 1
    }

    $ready = ConvertFrom-CodePoints @(0xC900,0xBE44,0x20,0xC644,0xB8CC)
    Write-Output "Automoney $ready`: $adminUrl"
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
