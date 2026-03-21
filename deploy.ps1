param(
  [string]$ServerHost = "182.254.182.170",
  [string]$User = "root",
  [string]$RemoteRoot = "/var/stock-monitor-web",
  [string]$Pm2Name = "stock-monitor-server",
  [switch]$SkipFrontendBuild,
  [switch]$SkipBackendBuild
)

$ErrorActionPreference = "Stop"

function Require-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $name"
  }
}

Require-Command "scp"
Require-Command "ssh"
Require-Command "yarn"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$adminDir = Join-Path $projectRoot 'admin'
$adminDistDir = Join-Path $adminDir 'dist'
$serverDir = Join-Path $projectRoot 'server'

$remoteTarget = "${User}@${ServerHost}"
$remoteRootTarget = "${remoteTarget}:${RemoteRoot}"

Write-Host "Project root: $projectRoot"
Write-Host "Deploy target: $remoteRootTarget"

if (-not $SkipFrontendBuild) {
  Write-Host "== Frontend: yarn install + build =="
  yarn --cwd "$adminDir" install
  yarn --cwd "$adminDir" build
}

Write-Host "== Upload frontend dist =="
scp -r "$adminDistDir" "${remoteTarget}:${RemoteRoot}/admin/"

Write-Host "== Upload backend .env file =="
$prodEnvFile = Join-Path $projectRoot '.env.production'
if (-not (Test-Path $prodEnvFile)) {
  throw ".env.production file not found in project root. Please create it with production database credentials."
}
scp "$prodEnvFile" "${remoteTarget}:${RemoteRoot}/.env"

Write-Host "== Upload backend (exclude node_modules) =="
$tempTarBackend = [System.IO.Path]::GetTempFileName() + ".tar.gz"

# 打包后端，排除 node_modules
tar -czf "$tempTarBackend" -C "$serverDir" --exclude='node_modules' .

scp "$tempTarBackend" "${remoteTarget}:${RemoteRoot}/server.tar.gz"

$remoteCmd = @()
$remoteCmd += "set -e"
$remoteCmd += "cd $RemoteRoot/server"
$remoteCmd += "tar -xzf ../server.tar.gz --overwrite"
$remoteCmd += "rm ../server.tar.gz"
$remoteCmd += "if command -v yarn >/dev/null 2>&1; then yarn install --production=false; else npm i; fi"
if (-not $SkipBackendBuild) {
  $remoteCmd += "if command -v yarn >/dev/null 2>&1; then yarn build; else npm run build; fi"
}
$remoteCmd += "pm2 restart $Pm2Name || pm2 restart dist/index.js --name $Pm2Name"
$remoteCmd += "pm2 save || true"

Write-Host "== Remote: install/build/restart =="
ssh "$remoteTarget" ($remoteCmd -join "; ")

Write-Host "Done."
