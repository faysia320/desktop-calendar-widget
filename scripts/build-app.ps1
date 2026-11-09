param(
    [string]$TargetDirectory,
    [switch]$Distribution
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
if (!$TargetDirectory) { $TargetDirectory = Join-Path $repository 'src-tauri\target' }
$TargetDirectory = [IO.Path]::GetFullPath($TargetDirectory)
$profile = if ($Distribution) { 'distribution' } else { 'release' }
$totalWatch = [Diagnostics.Stopwatch]::StartNew()

Push-Location $repository
try {
    $frontendWatch = [Diagnostics.Stopwatch]::StartNew()
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    $frontendWatch.Stop()

    $nativeWatch = [Diagnostics.Stopwatch]::StartNew()
    # Pin a project-specific cache (or the explicit override), independent of a
    # CARGO_TARGET_DIR inherited from another workspace. Build only the EXE.
    & cargo build --manifest-path (Join-Path $repository 'src-tauri\Cargo.toml') `
        --bin desktop-calendar-widget --features tauri/custom-protocol `
        --profile $profile --locked --timings --target-dir $TargetDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    $nativeWatch.Stop()
    $totalWatch.Stop()

    $result = [ordered]@{
        profile = $profile
        frontendSeconds = [Math]::Round($frontendWatch.Elapsed.TotalSeconds, 2)
        nativeSeconds = [Math]::Round($nativeWatch.Elapsed.TotalSeconds, 2)
        totalSeconds = [Math]::Round($totalWatch.Elapsed.TotalSeconds, 2)
        executable = Join-Path $TargetDirectory "$profile\desktop-calendar-widget.exe"
        cargoTimings = Join-Path $TargetDirectory 'cargo-timings\cargo-timing.html'
    }
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $TargetDirectory 'widget-build-times.json') -Encoding utf8
    $result | ConvertTo-Json
} finally { Pop-Location }
