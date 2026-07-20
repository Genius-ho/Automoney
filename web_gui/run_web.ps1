$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot

function Compare-SecureBytes {
    param(
        [byte[]]$Left,
        [byte[]]$Right
    )

    $difference = $Left.Length -bxor $Right.Length
    $limit = [Math]::Max($Left.Length, $Right.Length)
    for ($index = 0; $index -lt $limit; $index++) {
        $leftByte = if ($index -lt $Left.Length) { $Left[$index] } else { 0 }
        $rightByte = if ($index -lt $Right.Length) { $Right[$index] } else { 0 }
        $difference = $difference -bor ($leftByte -bxor $rightByte)
    }
    return $difference -eq 0
}

try {
    $webPort = 8765
    if ($env:MUMAE_WEB_PORT) {
        $webPort = [int]$env:MUMAE_WEB_PORT
    }
    $existingListener = Get-NetTCPConnection -LocalPort $webPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($existingListener) {
        throw ('Web port {0} is already in use by process {1}. Close the existing web server and run this launcher again.' -f $webPort, $existingListener.OwningProcess)
    }

    $secureWebPassword = Read-Host 'Web login password' -AsSecureString
    $secureWebPasswordConfirmation = Read-Host 'Confirm web login password' -AsSecureString
    $passwordPointer = [IntPtr]::Zero
    $confirmationPointer = [IntPtr]::Zero
    $passwordBytes = $null
    $confirmationBytes = $null
    try {
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureWebPassword)
        $confirmationPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureWebPasswordConfirmation)
        $webPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
        $webPasswordConfirmation = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($confirmationPointer)
        if ([string]::IsNullOrWhiteSpace($webPassword)) {
            throw 'Web login password cannot be empty.'
        }
        $passwordBytes = [Text.Encoding]::UTF8.GetBytes($webPassword)
        $confirmationBytes = [Text.Encoding]::UTF8.GetBytes($webPasswordConfirmation)
        if (-not (Compare-SecureBytes $passwordBytes $confirmationBytes)) {
            throw 'Web login passwords do not match.'
        }
        $env:MUMAE_WEB_PASSWORD = $webPassword
    }
    finally {
        if ($passwordBytes) {
            [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
        }
        if ($confirmationBytes) {
            [Array]::Clear($confirmationBytes, 0, $confirmationBytes.Length)
        }
        if ($passwordPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
        }
        if ($confirmationPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($confirmationPointer)
        }
        $webPassword = $null
        $webPasswordConfirmation = $null
    }

    $env:MUMAE_DATA_DIR = $projectRoot
    Set-Location -LiteralPath $projectRoot
    & py (Join-Path $projectRoot 'mumae_cli.py') --data-dir $projectRoot serve --host 127.0.0.1 --port $webPort --open
    if ($LASTEXITCODE -ne 0) {
        throw ('The web server exited with code {0}.' -f $LASTEXITCODE)
    }
}
finally {
    Remove-Item Env:MUMAE_WEB_PASSWORD -ErrorAction SilentlyContinue
}