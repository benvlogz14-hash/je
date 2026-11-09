# Connects the Claude desktop app (and Claude Code, if installed) to the Euclidean app on this PC.
# Run by "Connect Claude to Euclidean.bat". Adds one entry ("euclidean") to Claude's MCP settings; nothing else changes.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'euclidean-mcp.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "Node.js isn't installed yet. Run 'Start Euclidean.bat' once (it installs Node), then run this again."; exit 1 }

function Add-Euclidean($cfg) {
  $dir = Split-Path $cfg
  New-Item -ItemType Directory -Force $dir | Out-Null
  $j = $null
  if (Test-Path $cfg) { try { $j = Get-Content $cfg -Raw | ConvertFrom-Json } catch { Copy-Item $cfg "$cfg.bak" -Force; $j = $null } }
  if (-not $j) { $j = [pscustomobject]@{} }
  if (-not ($j.PSObject.Properties.Name -contains 'mcpServers') -or -not $j.mcpServers) { $j | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force }
  $entry = [pscustomobject]@{ command = $node; args = @($script) }
  $j.mcpServers | Add-Member -NotePropertyName euclidean -NotePropertyValue $entry -Force
  [IO.File]::WriteAllText($cfg, ($j | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding $false))
  Write-Host "Connected: $cfg"
}

$done = 0
# The Claude desktop app (the usual install, and the Microsoft Store install).
Add-Euclidean (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'); $done++
Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue | ForEach-Object {
  Add-Euclidean (Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'); $done++
}
# Claude Code, if it's installed.
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if ($claude) {
  $ErrorActionPreference = 'Continue'  # its "nothing to remove" message isn't an error
  try { & $claude mcp remove --scope user euclidean *> $null } catch { }
  try { & $claude mcp add --scope user euclidean -- $node $script; Write-Host 'Connected Claude Code too.' } catch { Write-Host "Couldn't connect Claude Code: $($_.Exception.Message)" }
}
Write-Host ''
Write-Host 'Done. Quit the Claude app completely (right-click its icon by the clock, Quit) and open it again.'
Write-Host 'Keep Euclidean open: Claude talks to it while it is running.'
