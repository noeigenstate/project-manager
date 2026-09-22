$ErrorActionPreference = 'Continue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'refresh-path.ps1')
$global:ProjectGridSession = Get-Content -LiteralPath $env:PROJECT_GRID_BOOTSTRAP -Raw -Encoding UTF8 | ConvertFrom-Json
$global:ProjectGridEventSequence = 0
Set-Location -LiteralPath $global:ProjectGridSession.projectPath
$global:ProjectGridCodexCommand = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
$global:ProjectGridCodexExecutable = $global:ProjectGridCodexCommand
$global:ProjectGridCodexPrefix = @()
if ($global:ProjectGridCodexCommand -and [IO.Path]::GetExtension($global:ProjectGridCodexCommand) -in @('.ps1', '.cmd')) {
    $npmEntry = Join-Path (Split-Path $global:ProjectGridCodexCommand -Parent) 'node_modules\@openai\codex\bin\codex.js'
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
    if ((Test-Path -LiteralPath $npmEntry) -and $nodeCommand) {
        $global:ProjectGridCodexExecutable = $nodeCommand
        $global:ProjectGridCodexPrefix = @($npmEntry)
    }
}

# Windows PowerShell 5 strips embedded quotes when forwarding native arguments.
# Build the standard Windows argv representation explicitly so notify's TOML
# array, Chinese paths, quotes and trailing backslashes reach Codex intact.
function global:ConvertTo-ProjectGridArgument {
    param([string]$Value)
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append([char]34)
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34) {
            [void]$builder.Append(([string][char]92) * ($slashes * 2 + 1))
        } else {
            [void]$builder.Append(([string][char]92) * $slashes)
        }
        [void]$builder.Append($character)
        $slashes = 0
    }
    [void]$builder.Append(([string][char]92) * ($slashes * 2))
    [void]$builder.Append([char]34)
    return $builder.ToString()
}

function global:Send-ProjectGridEvent {
    param([string]$Type, [int]$ExitCode = 0)
    $global:ProjectGridEventSequence++
    try {
        $eventData = @{
            projectId = $global:ProjectGridSession.projectId
            sessionKey = $global:ProjectGridSession.sessionKey
            type = $Type
            sequence = $global:ProjectGridEventSequence
            exitCode = $ExitCode
            codexAvailable = [bool]$global:ProjectGridCodexCommand
            codexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' })
            cwd = (Get-Location).Path
        } | ConvertTo-Json -Compress
        $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $global:ProjectGridSession.pipeName, [System.IO.Pipes.PipeDirection]::Out)
        try {
            $pipe.Connect(750)
            $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false))
            try { $writer.WriteLine($eventData); $writer.Flush() } finally { $writer.Dispose() }
        } finally { $pipe.Dispose() }
    } catch { }
}

function global:codex {
    if (-not $global:ProjectGridCodexCommand) {
        Write-Host 'Codex CLI was not found in PATH. Install it, then restart this terminal.' -ForegroundColor Yellow
        return
    }
    $forwardArgs = @($args)
    $notifyCommand = @(
        $global:ProjectGridSession.powershellPath,
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $global:ProjectGridSession.notifyPath,
        '-PipeName', $global:ProjectGridSession.pipeName,
        '-ProjectId', $global:ProjectGridSession.projectId,
        '-SessionKey', $global:ProjectGridSession.sessionKey
    ) | ConvertTo-Json -Compress
    Send-ProjectGridEvent 'codex-started'
    $codexExit = 0
    try {
        if ([IO.Path]::GetExtension($global:ProjectGridCodexExecutable) -ne '.exe') {
            throw 'Use a native Codex executable or the standard npm installation of Codex.'
        }
        $nativeArgs = @($global:ProjectGridCodexPrefix) + @('-c', ('notify=' + $notifyCommand), '-c', 'tui.terminal_title=["session-id"]') + $forwardArgs
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $global:ProjectGridCodexExecutable
        $startInfo.Arguments = (($nativeArgs | ForEach-Object { ConvertTo-ProjectGridArgument ([string]$_) }) -join ' ')
        $startInfo.UseShellExecute = $false
        $startInfo.WorkingDirectory = (Get-Location).Path
        $codexProcess = [Diagnostics.Process]::Start($startInfo)
        try { $codexProcess.WaitForExit(); $codexExit = $codexProcess.ExitCode }
        finally { $codexProcess.Dispose() }
    } catch {
        Write-Error $_
        $codexExit = 1
    } finally {
        Send-ProjectGridEvent 'codex-exited' $codexExit
        $global:LASTEXITCODE = $codexExit
    }
}

function global:prompt {
    Send-ProjectGridEvent 'shell-prompt'
    'PS ' + (Get-Location).Path + '> '
}

# No user profile is modified. This wrapper exists only inside this terminal.
Write-Host '  PROJECT GRID' -ForegroundColor DarkGray
Write-Host '  Type codex to start, or codex resume to continue a session.' -ForegroundColor DarkGray
Write-Host ''
Send-ProjectGridEvent 'shell-ready'
