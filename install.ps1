param([string]$SourceDir = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-config.ps1')

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ($script:LogFile) {
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    }
}

$script:LogFile = Join-Path $SourceDir 'install.log'

try {
    $configFile = Join-Path $SourceDir 'config.json'
    $cfg = Get-DeployConfig -ConfigPath $configFile
    $deployPath = $cfg.DeployPath

    if ($cfg.RegistryScope -eq 'HKLM' -and -not (Test-IsAdmin)) {
        throw 'registryScope=HKLM requires administrator.'
    }

    if (-not (Test-Path -LiteralPath $deployPath)) {
        New-Item -ItemType Directory -Path $deployPath -Force | Out-Null
    }

    $script:LogFile = Join-Path $deployPath 'install.log'
    Write-Log "Install started. Computer=$env:COMPUTERNAME User=$env:USERNAME"
    Write-Log "Deploy: $deployPath Scope: $($cfg.RegistryScope)"

    Copy-Item -LiteralPath (Join-Path $SourceDir 'init.js') -Destination $deployPath -Force
    Copy-Item -LiteralPath $configFile -Destination $deployPath -Force

    $nodeExe = 'node'
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeExe = $nodeCmd.Source
    } elseif (Test-Path "${env:ProgramFiles}\nodejs\node.exe") {
        $nodeExe = "${env:ProgramFiles}\nodejs\node.exe"
    } elseif (Test-Path "${env:ProgramFiles(x86)}\nodejs\node.exe") {
        $nodeExe = "${env:ProgramFiles(x86)}\nodejs\node.exe"
    } else {
        Write-Log 'WARN: Node.js not found.'
    }

    $runCmd = Join-Path $deployPath 'run.cmd'
    @"
@echo off
cd /d "%~dp0"
"$nodeExe" init.js >nul 2>&1
"@ | Set-Content -LiteralPath $runCmd -Encoding ASCII

    Set-ItemProperty -Path $cfg.RegistryPath -Name $cfg.RegName -Value "`"$runCmd`"" -Type String -Force
    Write-Log "Registry: $($cfg.RegistryPath)\$($cfg.RegName)"
    Write-Log 'Install completed.'
    exit 0
} catch {
    if (-not $script:LogFile) {
        $script:LogFile = Join-Path $SourceDir 'install.log'
    }
    try { Write-Log "ERROR: $($_.Exception.Message)" } catch { }
    exit 1
}
