$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Aura DSH Bridge.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$node = Join-Path $here 'node.exe'
if (-not (Test-Path $node)) { $node = 'node.exe' }
$link.TargetPath = $node
$link.Arguments = 'sidecar.mjs'
$link.WorkingDirectory = $here
$link.WindowStyle = 7
$link.Save()
Write-Output $shortcut
