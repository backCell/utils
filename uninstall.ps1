param([string]$SourceDir = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'load-config.ps1')

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ($script:LogFile) {
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    }
}

$script:LogFile = Join-Path $SourceDir 'uninstall.log'

try {
    $configFile = Join-Path $SourceDir 'config.json'
    $cfg = Get-DeployConfig -ConfigPath $configFile
    $deployPath = $cfg.DeployPath

    if (Test-Path -LiteralPath $deployPath) {
        $script:LogFile = Join-Path $deployPath 'uninstall.log'
    }

    Write-Log "Uninstall started. Deploy=$deployPath"

    if ($deployPath -match '^[A-Za-z]:\\$') {
        throw "Refuse to delete drive root: $deployPath"
    }

    if ($cfg.RegistryScope -eq 'HKLM' -and -not (Test-IsAdmin)) {
        throw 'registryScope=HKLM requires administrator.'
    }

    if (Get-ItemProperty -Path $cfg.RegistryPath -Name $cfg.RegName -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $cfg.RegistryPath -Name $cfg.RegName -Force
        Write-Log 'Registry removed.'
    }

    if (Test-Path -LiteralPath $deployPath) {
        Remove-Item -LiteralPath $deployPath -Recurse -Force
        Write-Log 'Deploy folder removed.'
    }

    Write-Log 'Uninstall completed.'
    exit 0
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
}
