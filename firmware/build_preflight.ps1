param(
    [string]$IdfPath = 'C:\Espressif\v6.0.1\esp-idf',
    [string]$ToolsPath = 'C:\Espressif\tools',
    [string]$StageDir = 'C:\Espressif\projects\dot-device-bridge-usb-preflight',
    [switch]$CameraDriver,
    [switch]$CameraReady,
    [ValidateSet('NativeUsb','Uart0')][string]$Transport = 'NativeUsb',
    [ValidateRange(115200,2000000)][int]$UartBaud = 460800
)
$ErrorActionPreference = 'Stop'
if ($CameraReady) { $CameraDriver = $true }
. (Join-Path $PSScriptRoot 'enter_idf.ps1') -IdfPath $IdfPath -ToolsPath $ToolsPath
$stageFull = [IO.Path]::GetFullPath($StageDir)
if ($stageFull -match '\s' -or $stageFull.TrimEnd('\') -eq [IO.Path]::GetPathRoot($stageFull).TrimEnd('\') -or $stageFull.TrimEnd('\') -eq $PSScriptRoot.TrimEnd('\')) {
    throw 'Use a separate staging directory without spaces, never the source directory or a drive root.'
}
$marker = Join-Path $stageFull '.dot-build-stage'
if ((Test-Path -LiteralPath $stageFull) -and -not (Test-Path -LiteralPath $marker)) { throw 'Existing staging directory is not owned by this build entrypoint.' }
New-Item -ItemType Directory -Path $stageFull -Force | Out-Null
Set-Content -LiteralPath $marker -Value 'dot-device-bridge-usb build-only stage' -Encoding utf8
# Copy only reviewed source/build inputs; no .env or hardware scripts.
foreach ($name in @('main', 'components')) {
    $target = Join-Path $stageFull $name
    if (Test-Path -LiteralPath $target) {
        $resolved = [IO.Path]::GetFullPath($target)
        if (-not $resolved.StartsWith($stageFull.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging path' }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $target -Recurse
}
foreach ($name in @('CMakeLists.txt', 'sdkconfig.defaults', 'partitions.csv', 'camera.driver.defaults', 'camera.ready.defaults', 'transport.uart0.defaults')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $stageFull $name) -Force
}
$profile = if ($CameraReady) { 'camera-ready' } elseif ($CameraDriver) { 'camera-driver' } else { 'camera-disabled' }
if ($Transport -eq 'Uart0') {
    $profile += '-uart0'
    if ($UartBaud -ne 460800) { $profile += "-$UartBaud" }
}
$buildDir = Join-Path $stageFull "build\$profile"
$defaults = Join-Path $stageFull 'sdkconfig.defaults'
$extra = @()
if ($CameraDriver) {
    Set-Content -LiteralPath (Join-Path $stageFull 'main\idf_component.yml') -Value "dependencies:`n  espressif/esp32-camera: '2.1.8'" -Encoding utf8
    $env:IDF_COMPONENT_MANAGER = '1'
    $cameraDefaults = if ($CameraReady) { 'camera.ready.defaults' } else { 'camera.driver.defaults' }
    $defaults += ';' + (Join-Path $stageFull $cameraDefaults)
    $extra += '-DDOT_CAMERA_DRIVER_COMPONENT=espressif__esp32-camera'
} else { $env:IDF_COMPONENT_MANAGER = '0' }
if ($Transport -eq 'Uart0') {
    $uartDefaults = Join-Path $stageFull 'transport.uart0.defaults'
    $uartText = (Get-Content -LiteralPath $uartDefaults -Raw) -replace '(?m)^(CONFIG_(DOT_UART0_BAUDRATE|ESP_CONSOLE_UART_BAUDRATE))=\d+', "`$1=$UartBaud"
    Set-Content -LiteralPath $uartDefaults -Value $uartText -Encoding utf8
    $defaults += ';' + $uartDefaults
}
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
& python (Join-Path $IdfPath 'tools\idf.py') -C $stageFull -B $buildDir '-DIDF_TARGET=esp32s3' "-DSDKCONFIG=$buildDir\sdkconfig" "-DSDKCONFIG_DEFAULTS=$defaults" @extra build
if ($LASTEXITCODE -ne 0) { throw 'Build-only firmware compilation failed.' }
$config = Get-Content -LiteralPath (Join-Path $buildDir 'sdkconfig') -Raw
if ($CameraReady) {
    foreach ($key in @('DOT_CAMERA_DRIVER_ENABLED','DOT_CAMERA_BOARD_CONFIRMED','DOT_CAMERA_CAPTURE_ALLOWED')) {
        if ($config -notmatch "(?m)^CONFIG_${key}=y$") { throw "Missing camera-ready flag: $key" }
    }
} elseif ($config -match '(?m)^CONFIG_DOT_CAMERA_(BOARD_CONFIRMED|CAPTURE_ALLOWED)=y$') {
    throw 'Only the explicit -CameraReady build may enable camera requests.'
}
if ($Transport -eq 'Uart0') {
    foreach ($value in @('DOT_TRANSPORT_UART0=y',"DOT_UART0_BAUDRATE=$UartBaud",'ESP_CONSOLE_UART_CUSTOM=y','ESP_CONSOLE_UART_NUM=0','ESP_CONSOLE_UART_TX_GPIO=43','ESP_CONSOLE_UART_RX_GPIO=44',"ESP_CONSOLE_UART_BAUDRATE=$UartBaud")) {
        if ($config -notmatch "(?m)^CONFIG_$([regex]::Escape($value))$") { throw "UART config did not match: $value" }
    }
} elseif ($config -match '(?m)^CONFIG_DOT_TRANSPORT_UART0=y$') { throw 'Native USB build has an unexpected UART transport.' }
Write-Output "Build finished: $buildDir. Transport=$Transport. No serial port was opened."
