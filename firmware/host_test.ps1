param([string]$HostCompiler = $env:DOT_HOST_CC)
$ErrorActionPreference = 'Stop'
if (-not $HostCompiler) {
    throw 'Pass -HostCompiler with your LLVM-MinGW clang.exe path.'
}
if (-not (Test-Path -LiteralPath $HostCompiler)) { throw 'Specify -HostCompiler with the LLVM-MinGW clang.exe path (ASan/UBSan supported).' }
$env:DOT_HOST_CC = $HostCompiler
$env:PATH = (Split-Path -Parent $HostCompiler) + ';' + $env:PATH
$env:PYTHONUTF8 = '1'
& python -X utf8 -B -m unittest discover -s (Join-Path $PSScriptRoot 'tests') -v
if ($LASTEXITCODE -ne 0) { throw 'Firmware host tests failed.' }
