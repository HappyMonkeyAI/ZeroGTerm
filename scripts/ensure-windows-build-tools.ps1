# Run before Windows source packaging. Adds only the missing Spectre component;
# never disables compiler mitigations or restarts Windows.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This prerequisite check requires Windows.' }
$installerDirectory = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer'
$vswhere = Join-Path $installerDirectory 'vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Install Visual Studio Build Tools with the C++ desktop workload first; import .vsconfig.' }
$instances = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json)
if ($instances.Count -ne 1) { throw 'No C++ Build Tools instance was found; import .vsconfig in Visual Studio Installer.' }
$buildToolsPath = $instances[0].installationPath
$versionFile = Join-Path $buildToolsPath 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'
$toolsetVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
$spectreLibrary = Join-Path $buildToolsPath "VC/Tools/MSVC/$toolsetVersion/lib/spectre/x64/libcmt.lib"
if (-not (Test-Path -LiteralPath $spectreLibrary)) {
    $setup = Join-Path $installerDirectory 'setup.exe'
    $arguments = 'modify --installPath "' + $buildToolsPath + '" --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --quiet --norestart'
    $start = @{ FilePath=$setup; ArgumentList=$arguments; WindowStyle='Hidden'; Wait=$true; PassThru=$true }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $start.Verb = 'RunAs' }
    $installer = Start-Process @start
    if ($installer.ExitCode -notin @(0, 3010)) { throw "Spectre component installation failed: $($installer.ExitCode)." }
    $toolsetVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    $spectreLibrary = Join-Path $buildToolsPath "VC/Tools/MSVC/$toolsetVersion/lib/spectre/x64/libcmt.lib"
    if (-not (Test-Path -LiteralPath $spectreLibrary)) { throw 'The selected toolset still has no Spectre libraries. Review Visual Studio Installer before building.' }
}
Write-Output "Windows C++ toolset ${toolsetVersion}: Spectre libraries ready."
