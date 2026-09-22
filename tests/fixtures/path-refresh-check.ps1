param([string]$Script, [string]$Cases)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:PG_PATH_ROOT = 'C:\Known Root'
$env:PG_KEEP_VALUE = 'unchanged'
$pgCases = Get-Content -LiteralPath $Cases -Raw -Encoding UTF8 | ConvertFrom-Json
$pgResults = foreach ($pgCase in $pgCases) {
    $env:Path = [string]$pgCase.inherited
    $pgReads = [Collections.Generic.List[string]]::new()
    $pgReader = {
        param($Scope)
        $pgReads.Add($Scope)
        if ($Scope -eq $pgCase.fail) { throw 'isolated read failure' }
        return $pgCase.$Scope
    }
    . $Script -ReadPath $pgReader
    $pgFirst = $env:Path
    if ($pgCase.nextUser) { $pgCase.User = $pgCase.nextUser }
    . $Script -ReadPath $pgReader
    [pscustomobject]@{ name = $pgCase.name; first = $pgFirst; second = $env:Path; reads = @($pgReads); kept = $env:PG_KEEP_VALUE }
}
ConvertTo-Json -InputObject @($pgResults) -Depth 4 -Compress
