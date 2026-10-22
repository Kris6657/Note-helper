param(
    [ValidatePattern('^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$')]
    [string]$Version = '0.1.0-preview.1',
    [string]$BuildPython = ''
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This build targets Windows x64.' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $BuildPython) { $BuildPython = Join-Path $projectRoot '.venv-build/Scripts/python.exe' }
if (-not (Test-Path -LiteralPath $BuildPython -PathType Leaf)) {
    throw 'Build Python not found. Prepare .venv-build using requirements-build.txt first.'
}
$BuildPython = (Resolve-Path -LiteralPath $BuildPython).Path
& $BuildPython -c "import platform,struct,PyInstaller; assert struct.calcsize('P') == 8 and platform.system() == 'Windows'; assert PyInstaller.__version__ == '6.22.3'"
if ($LASTEXITCODE -ne 0) { throw 'Expected Windows x64 Python with pinned PyInstaller 6.22.3.' }
$runId = [guid]::NewGuid().ToString('N')
$work = Join-Path $projectRoot ('build/' + $runId)
$output = Join-Path $projectRoot ('dist/' + $Version + '-' + $runId.Substring(0, 8))
if ((Test-Path -LiteralPath $work) -or (Test-Path -LiteralPath $output)) { throw 'Output already exists.' }
New-Item -ItemType Directory -Path $work | Out-Null
New-Item -ItemType Directory -Path $output | Out-Null
$source = Join-Path $work 'source'
$bundle = Join-Path $output 'Note-helper'
$zip = Join-Path $output ('Note-helper-' + $Version + '-windows-x64.zip')
$oldLocation = Get-Location
$oldConfig = $env:PYINSTALLER_CONFIG_DIR
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$oldPythonPath = $env:PYTHONPATH
try {
    Set-Location -LiteralPath $projectRoot
    $env:PYTHONPATH = ''
    & $BuildPython -m tools.build_release stage $projectRoot $source
    if ($LASTEXITCODE -ne 0) { throw 'Public source staging failed.' }
    $env:PYINSTALLER_CONFIG_DIR = Join-Path $work 'cache'
    $env:TEMP = Join-Path $work 'tmp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP | Out-Null
    Set-Location -LiteralPath $source
    & $BuildPython -m PyInstaller --distpath $output --workpath (Join-Path $work 'analysis') (Join-Path $source 'Note-helper.spec')
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed. Existing packages were not replaced.' }
    Set-Location -LiteralPath $projectRoot
    & $BuildPython -m tools.build_release finish $projectRoot $bundle --version $Version --zip $zip
    if ($LASTEXITCODE -ne 0) { throw 'Package assembly failed; do not distribute this output.' }
    Write-Output ('BUNDLE=' + $bundle)
    Write-Output ('ZIP=' + $zip)
} finally {
    Set-Location -LiteralPath $oldLocation.Path
    $env:PYINSTALLER_CONFIG_DIR = $oldConfig
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    $env:PYTHONPATH = $oldPythonPath
}
