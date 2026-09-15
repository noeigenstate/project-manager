param([Parameter(Mandatory=$true)][string]$Destination, [Parameter(Mandatory=$true)][string]$Expected)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files.Count -ne 1 -or $files[0] -ne $Expected) { throw 'Unexpected test clipboard content.' }
$folder = (New-Object -ComObject Shell.Application).Namespace($Destination)
if (-not $folder) { throw 'Test destination is missing.' }
$folder.Self.InvokeVerb('paste')
