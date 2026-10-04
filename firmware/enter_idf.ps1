param([string]$IdfPath = 'C:\Espressif\v6.0.1\esp-idf', [string]$ToolsPath = 'C:\Espressif\tools')
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $IdfPath 'export.ps1'))) { throw "ESP-IDF not found: $IdfPath" }
$env:PYTHONUTF8 = '1'
$version = Split-Path -Leaf (Split-Path -Parent $IdfPath)
$eimProfile = Join-Path $ToolsPath "Microsoft.$version.PowerShell_profile.ps1"
if (Test-Path -LiteralPath $eimProfile) {
    . $eimProfile
    if ([IO.Path]::GetFullPath($env:IDF_PATH) -ne [IO.Path]::GetFullPath($IdfPath)) { throw 'EIM profile points at a different ESP-IDF installation.' }
} else {
    $env:IDF_TOOLS_PATH = $ToolsPath
    . (Join-Path $IdfPath 'export.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF environment activation failed.' }
}
