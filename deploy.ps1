param(
  [string]$ServerHost = "182.254.182.170",
  [string]$User = "root",
  [string]$RemoteRoot = "/var/stock-monitor-web",
  [string]$Pm2Name = "stock-monitor-server",
  [string]$AgentsPm2Name = "stock-monitor-agents",
  [switch]$SkipFrontendBuild,
  [switch]$SkipBackendBuild,
  [switch]$SkipAgentsDeploy
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
Require-Command "tar"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$adminDir = Join-Path $projectRoot 'admin'
$adminDistDir = Join-Path $adminDir 'dist'
$serverDir = Join-Path $projectRoot 'server'
$agentsDir = Join-Path $projectRoot 'agents'

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
Remove-Item -Force "$tempTarBackend" -ErrorAction SilentlyContinue

if (-not $SkipAgentsDeploy) {
  Write-Host "== Upload agents (python service) =="
  $tempTarAgents = [System.IO.Path]::GetTempFileName() + ".tar.gz"

  # 打包 agents，排除缓存与编译产物
  tar -czf "$tempTarAgents" -C "$agentsDir" --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' --exclude='.venv' .

  scp "$tempTarAgents" "${remoteTarget}:${RemoteRoot}/agents.tar.gz"
  Remove-Item -Force "$tempTarAgents" -ErrorAction SilentlyContinue
}

$remoteCmd = @()
$remoteCmd += "set -e"

# --- backend ---
$remoteCmd += "cd $RemoteRoot/server"
$remoteCmd += "tar -xzf ../server.tar.gz --overwrite"
$remoteCmd += "rm ../server.tar.gz"
$remoteCmd += "if command -v yarn >/dev/null 2>&1; then yarn install --production=false; else npm i; fi"
if (-not $SkipBackendBuild) {
  $remoteCmd += "if command -v yarn >/dev/null 2>&1; then yarn build; else npm run build; fi"
}
$remoteCmd += "pm2 restart $Pm2Name || pm2 restart dist/index.js --name $Pm2Name"
$remoteCmd += "pm2 save || true"

# --- agents (python) ---
if (-not $SkipAgentsDeploy) {
  $remoteCmd += "mkdir -p $RemoteRoot/agents"
  $remoteCmd += "cd $RemoteRoot/agents"
  $remoteCmd += "tar -xzf ../agents.tar.gz --overwrite"
  $remoteCmd += "rm ../agents.tar.gz"

  # 依赖安装：使用 venv，避免污染系统 python
  $remoteCmd += "command -v python3 >/dev/null 2>&1 || (echo 'python3 not found on server' && exit 1)"
  $remoteCmd += "[ -x .venv/bin/python ] || python3 -m venv .venv"
  $remoteCmd += ".venv/bin/pip install -U pip"
  $remoteCmd += ".venv/bin/pip install -r requirements.txt"

  # 用 pm2 守护 uvicorn（端口从 AGENTS_PORT 读取，默认 8009）
  $remoteCmd += 'pm2 restart ' + $AgentsPm2Name + ' || pm2 start .venv/bin/python --name ' + $AgentsPm2Name + ' -- -m uvicorn main:app --host 0.0.0.0 --port ${AGENTS_PORT:-8009}'
  $remoteCmd += "pm2 save || true"
}

Write-Host "== Remote: install/build/restart =="
ssh "$remoteTarget" ($remoteCmd -join "; ")

Write-Host "Done."
