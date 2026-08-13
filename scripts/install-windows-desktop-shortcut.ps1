[CmdletBinding()]
param(
    [switch]$Describe
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot 'run-admin-server-windows.ps1'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutName = 'Automoney ' + [char]0xC2DC + [char]0xC791 + '.lnk'
$shortcutPath = Join-Path $desktopPath $shortcutName
$targetPath = 'powershell.exe'
$arguments = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$launcherPath`""

$description = [ordered]@{
    shortcutPath = $shortcutPath
    targetPath = $targetPath
    arguments = $arguments
    workingDirectory = $repositoryRoot
}

if ($Describe) {
    $description | ConvertTo-Json -Compress
    exit 0
}

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    $notFound = -join (@(0xC2E4,0xD589,0xAE30,0x20,0xD30C,0xC77C,0xC744,0x20,0xCC3E,0xC744,0x20,0xC218,0x20,0xC5C6,0xC2B5,0xB2C8,0xB2E4) | ForEach-Object { [char]$_ })
    [Console]::Error.WriteLine("Automoney Windows $notFound.")
    exit 2
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $repositoryRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
$shortcut.Save()

$created = -join (@(0xBC14,0xD0D5,0xD654,0xBA74,0x20,0xBC14,0xB85C,0xAC00,0xAE30,0xB97C,0x20,0xB9CC,0xB4E4,0xC5C8,0xC2B5,0xB2C8,0xB2E4) | ForEach-Object { [char]$_ })
Write-Output "$created`: $shortcutPath"
