$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $here 'node.exe'
if (-not (Test-Path $node)) { $node = 'node.exe' }
Start-Process -FilePath $node -ArgumentList 'sidecar.mjs' -WorkingDirectory $here -WindowStyle Hidden -RedirectStandardOutput (Join-Path $here 'bridge.out.log') -RedirectStandardError (Join-Path $here 'bridge.err.log')
Start-Sleep -Seconds 2
Write-Host 'Aura DSH Bridge started in background.'
Write-Host ('Logs: ' + (Join-Path $here 'bridge.out.log'))
