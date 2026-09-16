param(
    [Parameter(Mandatory=$true)][string]$PipeName,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$SessionKey,
    [Parameter(Mandatory=$true)][string]$Payload
)

# Codex supplies one JSON argument per completed turn. Never infer completion
# from process exit, terminal silence, or words in model output.
$ErrorActionPreference = 'Stop'
try {
    $notification = $Payload | ConvertFrom-Json
    if ($notification.type -ne 'agent-turn-complete') { exit 0 }
    $threadId = [string]$notification.'thread-id'
    $turnId = [string]$notification.'turn-id'
    if ($threadId -and $turnId) {
        $eventId = $threadId + ':' + $turnId
    } else {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try { $eventId = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Payload))).Replace('-', '') }
        finally { $hasher.Dispose() }
    }
    $eventData = @{
        projectId = $ProjectId
        sessionKey = $SessionKey
        type = 'turn-complete'
        eventId = $eventId
        threadId = $threadId
        turnId = $turnId
    } | ConvertTo-Json -Compress
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::Out)
    try {
        $pipe.Connect(750)
        $writer = [System.IO.StreamWriter]::new($pipe, [System.Text.UTF8Encoding]::new($false))
        try { $writer.WriteLine($eventData); $writer.Flush() } finally { $writer.Dispose() }
    } finally { $pipe.Dispose() }
} catch {
    # A closed Project Grid must never interrupt Codex.
}
exit 0
