$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Aura DSH Bridge.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = 'C:\Program Files\nodejs\node.exe'
$link.Arguments = 'sidecar.mjs'
$link.WorkingDirectory = 'D:\AI项目\第三方dsapp\dsh-plugin'
$link.WindowStyle = 7
$link.Save()
Write-Output $shortcut
