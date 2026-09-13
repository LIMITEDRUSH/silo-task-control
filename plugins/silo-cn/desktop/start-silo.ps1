$ErrorActionPreference = "Stop"
$launcherPath = Join-Path $PSScriptRoot "launch.mjs"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) {
    $codexBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    $nodePath = Get-ChildItem -LiteralPath $codexBinRoot -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $nodePath) { throw "Node.js 22.5 or newer is required." }
& $nodePath $launcherPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
