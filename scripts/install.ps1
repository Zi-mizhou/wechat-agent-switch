param([Parameter(Mandatory=$true)][string]$InstallDir,[Parameter(Mandatory=$true)][string]$WorkspaceRoot,[Parameter(Mandatory=$true)][string]$CodexBin)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $CodexBin -PathType Leaf)) { throw 'CodexBin must be an existing stable CLI executable.' }
$target = [IO.Path]::GetFullPath($InstallDir)
$resolvedCodexBin = [IO.Path]::GetFullPath($CodexBin)
$resolvedWorkspace = [IO.Path]::GetFullPath($WorkspaceRoot)
if (Test-Path -LiteralPath (Join-Path $target 'package.json')) { throw 'Existing installation detected. Update its source deliberately; this installer does not overwrite it.' }
$template = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/bridge'
New-Item -ItemType Directory -Force -Path $target,$WorkspaceRoot | Out-Null
Copy-Item -Path (Join-Path $template '*') -Destination $target -Recurse
Push-Location -LiteralPath $target
try {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  & npm.cmd run verify
  if ($LASTEXITCODE -ne 0) { throw 'Bridge verification failed' }
  $env:CODEX_WEIXIN_STATE_DIR = Join-Path $target '.local-state'
  & node --input-type=module -e 'import {loadConfig,saveConfig} from "./dist/config.js"; const c=loadConfig(); c.codexBin=process.argv[1]; c.defaultCwd=process.argv[2]; c.security.allowedCwds=[c.defaultCwd]; c.hybridEnabled=true; c.desktopMirror.enabled=false; saveConfig(c);' $resolvedCodexBin $resolvedWorkspace
  if ($LASTEXITCODE -ne 0) { throw 'Config initialization failed' }
  Write-Output 'Source installed. Complete WeChat login, authorize your peer, and test before registering autostart. See references/operations.md.'
} finally { Pop-Location }
