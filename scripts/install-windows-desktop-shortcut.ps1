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
    [Console]::Error.WriteLine('Automoney Windows 실행기 파일을 찾을 수 없습니다.')
    exit 2
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $repositoryRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
$shortcut.Save()

Write-Output "바탕화면 바로가기를 만들었습니다: $shortcutPath"
