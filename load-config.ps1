function Get-DeployConfig {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath
    )

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "config not found: $ConfigPath"
    }

    $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if (-not $raw.deployPath) {
        throw 'deployPath missing in config.json'
    }

    $scope = 'HKCU'
    if ($raw.registryScope) {
        $scope = [string]$raw.registryScope
    }
    $scope = $scope.ToUpperInvariant()
    if ($scope -notin @('HKCU', 'HKLM')) {
        throw "registryScope must be HKCU or HKLM, got: $scope"
    }

    $regName = 'InitTask'
    if ($raw.regName) {
        $regName = [string]$raw.regName
    }

    $deployPath = [Environment]::ExpandEnvironmentVariables([string]$raw.deployPath)
    $deployPath = [System.IO.Path]::GetFullPath($deployPath)

    return [PSCustomObject]@{
        DeployPath     = $deployPath
        RegistryScope  = $scope
        RegName        = $regName
        RegistryPath   = "${scope}:\Software\Microsoft\Windows\CurrentVersion\Run"
    }
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
