param(
    [Parameter(Mandatory=$true)][string]$Package,
    [string]$WorkRoot = '',
    [switch]$RequireNoPython
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows is required.' }
$Package = (Resolve-Path -LiteralPath $Package).Path
if ([IO.Path]::GetExtension($Package) -ne '.zip') { throw 'Pass the original portable ZIP.' }
$pythonCommands = @(Get-Command python,python3,py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name -Unique)
if ($RequireNoPython -and $pythonCommands.Count -gt 0) {
    throw 'Python commands are present. This host does not meet -RequireNoPython.'
}
if (-not $WorkRoot) { $WorkRoot = [IO.Path]::GetTempPath() }
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot)
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
$work = Join-Path $WorkRoot ('Note-helper-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$script:checks = New-Object 'System.Collections.Generic.List[string]'
$script:running = $null
$listener = $null

function Assert-Inside([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($work + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Test path escaped the disposable workspace.'
    }
    return $full
}
function Assert-That($Condition, [string]$Label) {
    if (-not $Condition) { throw ('FAILED: ' + $Label) }
    $script:checks.Add($Label)
    Write-Host ('PASS ' + $Label)
}
function Extract-Package([string]$Name) {
    $destination = Assert-Inside (Join-Path $work $Name)
    New-Item -ItemType Directory -Path $destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Package)
    try {
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.Contains(':') -or [IO.Path]::IsPathRooted($entry.FullName)) { throw 'Unsafe ZIP path.' }
            $target = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
            if (-not $target.StartsWith($destination + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP path traversal.' }
            if (-not $seen.Add($target)) { throw 'Duplicate ZIP path.' }
        }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Package, $destination)
    $bundle = Join-Path $destination 'Note-helper'
    $manifest = Get-Content -LiteralPath (Join-Path $bundle 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in $manifest.files) {
        $path = Assert-Inside (Join-Path $bundle $item.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Missing package file: ' + $item.path) }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw ('Package hash mismatch: ' + $item.path) }
    }
    $allFiles = @(Get-ChildItem -LiteralPath $bundle -Recurse -File)
    if ($allFiles.Count -ne @($manifest.files).Count + 1) { throw 'Unexpected files in fresh package.' }
    return $bundle
}
function Start-Exe([string]$Bundle, [string]$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $Bundle 'Note-helper.exe'
    $info.Arguments = $Arguments
    $info.WorkingDirectory = Join-Path $work 'unrelated-cwd'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['PATH'] = Join-Path $env:WINDIR 'System32'
    $info.EnvironmentVariables['NOTE_HELPER_NO_OPEN'] = '1'
    $info.EnvironmentVariables.Remove('PYTHONHOME')
    $info.EnvironmentVariables.Remove('PYTHONPATH')
    return [Diagnostics.Process]::Start($info)
}
function Check-Exe([string]$Bundle, [int]$Expected) {
    $p = Start-Exe $Bundle '--check'
    try {
        if (-not $p.WaitForExit(30000)) { $p.Kill(); throw 'EXE check timed out.' }
        if ($p.ExitCode -ne $Expected) { throw ('EXE check returned ' + $p.ExitCode + ': ' + $p.StandardError.ReadToEnd()) }
    } finally { $p.Dispose() }
}
function Stop-Server {
    if ($script:running) {
        if (-not $script:running.HasExited) { $script:running.Kill(); $script:running.WaitForExit() }
        $script:running.Dispose()
        $script:running = $null
    }
}
function Request-Local([string]$Url, [string]$Method = 'GET', [string]$Body = '', [string]$ETag = '', [string]$Range = '') {
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Method = $Method
    $request.Proxy = $null
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    if ($ETag) { $request.Headers['If-Match'] = $ETag }
    if ($Range) { $request.AddRange(0,15) }
    if ($Method -eq 'POST') {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
        $request.ContentType = 'application/json'
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    }
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
        if (-not $_.Exception.Response) { throw }
        $response = $_.Exception.Response
    }
    try {
        $memory = New-Object IO.MemoryStream
        $stream = $response.GetResponseStream()
        try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
        $bytes = $memory.ToArray()
        $memory.Dispose()
        $data = $null
        if ($response.ContentType.StartsWith('application/json')) { $data = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json }
        return [pscustomobject]@{ Status=[int]$response.StatusCode; Data=$data; Bytes=$bytes; ETag=$response.Headers['ETag'] }
    } finally { $response.Dispose() }
}
function Start-Server([string]$Bundle, [int]$Port) {
    Stop-Server
    $script:running = Start-Exe $Bundle ([string]$Port)
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        if ($script:running.HasExited) { throw ('Server exited: ' + $script:running.StandardError.ReadToEnd()) }
        for ($candidate=$Port; $candidate -lt [Math]::Min($Port+20,65536); $candidate++) {
            try {
                $url = 'http://127.0.0.1:' + $candidate
                $response = Request-Local ($url + '/api/modules')
                if ($response.Status -eq 200 -and [IO.Path]::GetFullPath($response.Data.courses) -eq (Join-Path $Bundle 'courses')) { return $url }
            } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    throw 'Server did not expose its own data directory.'
}
function Verify-Saved([string]$Url, [string]$Endpoint) {
    $read = Request-Local ($Url+$Endpoint)
    Assert-That ($read.Status -eq 200 -and $read.Data.blocks.b3.note -eq 'portable test' -and $read.Data.pages.'2'.star -eq $true) 'Saved data is readable'
}

$report = [ordered]@{ success=$false; pythonCommands=$pythonCommands; executablePATH='Windows System32 only';
                     cleanWindowsVerified=$false; checks=@(); error=$null }
try {
    New-Item -ItemType Directory -Path (Join-Path $work 'unrelated-cwd') | Out-Null
    $sidecar = $Package + '.sha256'
    if (Test-Path -LiteralPath $sidecar) {
        $expected = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0]
        Assert-That ((Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expected) 'ZIP SHA-256 matches sidecar'
    }
    $bundle = Extract-Package 'initial'
    Assert-That (Test-Path -LiteralPath (Join-Path $bundle 'Note-helper.exe')) 'Manifest and file hashes match'
    Check-Exe $bundle 0
    Assert-That $true 'EXE starts without a Python command on PATH'
    $worker = Assert-Inside (Join-Path $bundle '_internal/web/vendor/pdfjs-6.4.299/pdf.worker.min.mjs')
    $hiddenWorker = Assert-Inside ($worker+'.test-backup')
    Move-Item -LiteralPath $worker -Destination $hiddenWorker
    try { Check-Exe $bundle 1 } finally { Move-Item -LiteralPath $hiddenWorker -Destination $worker }
    Assert-That $true 'Missing resource fails closed'
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $url = Start-Server $bundle $port
    Assert-That ($url -ne ('http://127.0.0.1:'+$port)) 'Occupied port falls back to another port'
    $listener.Stop(); $listener=$null
    $modules = (Request-Local ($url+'/api/modules')).Data.modules
    Assert-That (@($modules).Count -eq 1) 'Only self-made demo is shipped'
    $module = @($modules)[0]
    $prefix = '/api/module/'+[uri]::EscapeDataString($module.course)+'/'+[uri]::EscapeDataString($module.module)
    $notes = Request-Local ($url+$prefix+'/notes')
    Assert-That ($notes.Status -eq 200 -and $notes.Data.markdown.Contains('P3')) 'Demo notes are readable'
    $pdf = Request-Local ($url+$prefix+'/pdf') 'GET' '' '' 'bytes=0-15'
    Assert-That ($pdf.Status -eq 206 -and [Text.Encoding]::ASCII.GetString($pdf.Bytes).StartsWith('%PDF-')) 'PDF range request works'
    $read = Request-Local ($url+$prefix+'/annotations')
    $payload = @{version=1;blocks=@{b3=@{color='yellow';note='portable test';mastered=$true}};
                 meta=@{preserve='portable extension'};pages=@{'2'=@{star=$true;flag=$true}}} | ConvertTo-Json -Depth 16 -Compress
    $saved = Request-Local ($url+$prefix+'/annotations') 'POST' $payload $read.ETag
    Assert-That ($saved.Status -eq 200 -and $saved.ETag) 'Annotations save with a new revision'
    $endpoint = $prefix+'/annotations'
    Verify-Saved $url $endpoint
    $stale = Request-Local ($url+$endpoint) 'POST' $payload $read.ETag
    Assert-That ($stale.Status -eq 409) 'Stale window cannot overwrite newer annotations'
    $anno = Assert-Inside (Join-Path (Join-Path (Join-Path (Join-Path $bundle 'courses') $module.course) $module.module) 'annotations.json')
    $hash = (Get-FileHash -LiteralPath $anno -Algorithm SHA256).Hash
    $attributes = [IO.File]::GetAttributes($anno)
    try {
        [IO.File]::SetAttributes($anno,[IO.FileAttributes]::ReadOnly)
        $failed = Request-Local ($url+$endpoint) 'POST' $payload $saved.ETag
        Assert-That ($failed.Status -eq 500 -and (Get-FileHash -LiteralPath $anno -Algorithm SHA256).Hash -eq $hash) 'Write failure preserves the previous file'
    } finally { [IO.File]::SetAttributes($anno,$attributes) }
    Stop-Server
    $url = Start-Server $bundle ($port+1)
    Verify-Saved $url $endpoint
    Stop-Server
    $moved = Assert-Inside (Join-Path $work (([char]0x4e2d).ToString()+[char]0x6587+' moved space'))
    $bundle = Assert-Inside $bundle
    Move-Item -LiteralPath $bundle -Destination $moved
    $url = Start-Server $moved ($port+1)
    Verify-Saved $url $endpoint
    Assert-That ((Request-Local ($url+'/api/modules')).Data.courses -eq (Join-Path $moved 'courses')) 'Relocated package uses its own sibling courses'
    Stop-Server
    $upgraded = Extract-Package 'upgrade-simulation'
    $freshCourses = Assert-Inside (Join-Path $upgraded 'courses')
    $reserved = Assert-Inside (Join-Path $upgraded 'courses-demo')
    Move-Item -LiteralPath $freshCourses -Destination $reserved
    $oldCourses = Assert-Inside (Join-Path $moved 'courses')
    Copy-Item -LiteralPath $oldCourses -Destination $freshCourses -Recurse
    $url = Start-Server $upgraded ($port+1)
    Verify-Saved $url $endpoint
    $upgradedAnno = Join-Path (Join-Path (Join-Path $freshCourses $module.course) $module.module) 'annotations.json'
    Assert-That ((Get-FileHash -LiteralPath $upgradedAnno -Algorithm SHA256).Hash -eq $hash) 'Simulated upgrade retains annotation bytes'
    $report.success = $true
} catch {
    $report.error = $_.Exception.Message
    Write-Host ('FAIL ' + $report.error)
} finally {
    Stop-Server
    if ($listener) { $listener.Stop() }
    $report.checks = @($script:checks.ToArray())
    $resultFile = Join-Path $work 'portable-test-results.json'
    $report | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $resultFile -Encoding UTF8
    Write-Output ('RESULT=' + $resultFile)
}
if (-not $report.success) { exit 1 }
Write-Output 'Portable checks passed. Clean Windows still requires a separate host.'
