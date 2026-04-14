param(
  [string]$ServerHost = "111.230.87.74",
  [string]$User = "ubuntu",
  # SSH private key path. After running once with -SetupSshKey, deployments should be passwordless.
  # Default: ~/.ssh/id_ed25519 (recommended) or fallback to ~/.ssh/id_rsa
  [string]$SshKeyPath = "",
  # One-time setup: generate key (if missing) and install public key to server authorized_keys.
  [switch]$SetupSshKey,
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
Require-Command "tar"
Require-Command "ssh-keygen"
Require-Command "icacls"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$adminDir = Join-Path $projectRoot 'admin'
$adminDistDir = Join-Path $adminDir 'dist'
$serverDir = Join-Path $projectRoot 'server'
$agentsDir = Join-Path $projectRoot 'agents'

$remoteTarget = "${User}@${ServerHost}"
$remoteRootTarget = "${remoteTarget}:${RemoteRoot}"

Write-Host "Project root: $projectRoot"
Write-Host "Deploy target: $remoteRootTarget"
function Resolve-SshKeyPath([string]$p) {
  if ($p -and $p.Trim().Length -gt 0) { return $p }
  # Project-provided key (preferred if present)
  $projectPem = Join-Path $projectRoot "ssh\\liangnp.pem"
  if (Test-Path -LiteralPath $projectPem) { return $projectPem }
  $sshDir = Join-Path $env:USERPROFILE ".ssh"
  $ed25519 = Join-Path $sshDir "id_ed25519"
  $rsa = Join-Path $sshDir "id_rsa"
  if (Test-Path $ed25519) { return $ed25519 }
  if (Test-Path $rsa) { return $rsa }
  return $ed25519
}

function Get-SshArgs([string]$keyPath) {
  $args = @()
  if ($keyPath) {
    $kp = $keyPath.Trim()
    try {
      if (Test-Path -LiteralPath $kp) {
        $args += "-i"
        $args += $kp
        $args += "-o"
        $args += "IdentitiesOnly=yes"
      }
    } catch {
      throw (
        "Invalid -SshKeyPath value. It must be a local private key file path, e.g. `"$env:USERPROFILE\.ssh\id_ed25519`".`n" +
        "Current value: $keyPath"
      )
    }
  }
  # Avoid interactive prompt on host key; accept on first use.
  $args += "-o"
  $args += "StrictHostKeyChecking=accept-new"
  return $args
}

function Ensure-WindowsPrivateKeyPermissions([string]$keyPath) {
  # Kept for backward compatibility; permissions are handled in Prepare-UsablePrivateKey.
}

function Test-OpenSshKeyReadable([string]$keyPath) {
  if (-not (Test-Path -LiteralPath $keyPath)) { return $false }
  try {
    $out = & ssh-keygen -y -f $keyPath 2>$null
    return ($LASTEXITCODE -eq 0) -and $out -and ($out.Trim().StartsWith("ssh-"))
  } catch {
    return $false
  }
}

function Fix-WindowsPrivateKeyPermissions([string]$keyPath) {
  if ($env:OS -ne "Windows_NT") { return }
  if (-not (Test-Path -LiteralPath $keyPath)) { return }

  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

  # This matches the manual steps that work reliably on Windows OpenSSH.
  & icacls $keyPath /inheritance:r 1>$null 2>$null
  & icacls $keyPath /grant:r "${user}:(F)" 1>$null 2>$null
  & icacls $keyPath /remove:g Everyone 'BUILTIN\Users' 'NT AUTHORITY\Authenticated Users' 1>$null 2>$null
}

function Prepare-UsablePrivateKey([string]$keyPath) {
  if ($env:OS -ne "Windows_NT") { return $keyPath }
  if (-not (Test-Path -LiteralPath $keyPath)) { return $keyPath }

  # If it's already usable by OpenSSH, keep it as-is.
  if (Test-OpenSshKeyReadable $keyPath) { return $keyPath }

  # Try fixing ACL in-place and re-test.
  Fix-WindowsPrivateKeyPermissions $keyPath
  if (Test-OpenSshKeyReadable $keyPath) { return $keyPath }

  # Fallback: copy key to an ASCII-only path under %TEMP% and fix ACL there.
  $dstDir = Join-Path $env:TEMP "stock-monitor-deploy-key"
  if (-not (Test-Path -LiteralPath $dstDir)) {
    New-Item -ItemType Directory -Path $dstDir | Out-Null
  }

  $dst = Join-Path $dstDir ("deploy_" + [System.IO.Path]::GetFileName($keyPath))
  try {
    Copy-Item -LiteralPath $keyPath -Destination $dst -Force
  } catch {
    throw (
      "Cannot read/copy the private key file: $keyPath`n" +
      "Please ensure the current user has Read permission to the file, or copy it to a user-owned folder and pass -SshKeyPath."
    )
  }

  Fix-WindowsPrivateKeyPermissions $dst
  if (Test-OpenSshKeyReadable $dst) { return $dst }

  $userName = $null
  try { $userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { $userName = $env:USERNAME }
  $manual = @(
    "icacls `"$keyPath`" /inheritance:r",
    "icacls `"$keyPath`" /grant:r `"$userName`:(F)`"",
    "icacls `"$keyPath`" /remove:g Everyone `"BUILTIN\\Users`" `"NT AUTHORITY\\Authenticated Users`""
  ) -join "`n  "

  throw (
    "Failed to make private key usable for OpenSSH on Windows.`n" +
    "Tried original: $keyPath`n" +
    "Tried copied  : $dst`n" +
    "Please run the following commands in PowerShell (or run PowerShell as Administrator):`n  $manual"
  )
}

function Test-SshNonInteractive([string]$remote, [string[]]$sshArgs) {
  try {
    # BatchMode=yes disables password prompt; we want to know if key auth works.
    $testArgs = @($sshArgs + @("-o","BatchMode=yes","-o","ConnectTimeout=5"))
    & ssh @testArgs $remote "echo ok" 1>$null 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Ensure-SshKeyPair([string]$keyPath) {
  $pub = "${keyPath}.pub"
  $hasPriv = $false
  $hasPub = $false
  try {
    $hasPriv = Test-Path -LiteralPath $keyPath
    $hasPub = Test-Path -LiteralPath $pub
  } catch {
    throw "Invalid SSH key path: $keyPath"
  }

  if ($hasPriv -and $hasPub) { return }

  if (-not $hasPriv -and $hasPub) {
    throw "Private key is missing but public key exists: $pub"
  }

  # If private key exists but .pub is missing, derive the public key from the private key.
  if ($hasPriv -and -not $hasPub) {
    Ensure-WindowsPrivateKeyPermissions $keyPath
    Write-Host "Public key missing; deriving from existing private key: $keyPath"
    $out = & ssh-keygen -y -f $keyPath
    if ($LASTEXITCODE -ne 0 -or -not $out -or $out.Trim().Length -eq 0) {
      throw "Failed to derive public key from private key: $keyPath"
    }
    # authorized_keys expects LF; keep it simple.
    Set-Content -LiteralPath $pub -Value ($out.Trim() + "`n") -Encoding ascii
    return
  }
  $dir = Split-Path -Parent $keyPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  Write-Host "Generating SSH key: $keyPath"
  & ssh-keygen -t ed25519 -f $keyPath -N "" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "ssh-keygen failed. If the file already exists, please choose a new -SshKeyPath or remove the existing key first: $keyPath"
  }
  if (-not (Test-Path -LiteralPath $pub)) { throw "Public key not found: $pub" }
}

function Install-PublicKey([string]$remote, [string]$pubKeyPath, [string[]]$sshArgs) {
  if (-not (Test-Path $pubKeyPath)) { throw "Public key not found: $pubKeyPath" }
  Write-Host "Installing public key to server authorized_keys (may ask for password once)..."
  # Note: This step may prompt password once; afterwards deployments will be passwordless.
  # Read key from stdin and only append if missing (avoid duplicated lines).
  # Use single-quoted string to avoid PowerShell expanding $() / $key locally.
  $remoteCmd = 'key=$(cat); mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; grep -qxF "$key" ~/.ssh/authorized_keys || echo "$key" >> ~/.ssh/authorized_keys'
  Get-Content -Raw $pubKeyPath | & ssh @sshArgs $remote $remoteCmd
  if ($LASTEXITCODE -ne 0) { throw "Failed to install SSH public key to server." }
}

$SshKeyPath = Resolve-SshKeyPath $SshKeyPath
$SshKeyPath = Prepare-UsablePrivateKey $SshKeyPath
$sshArgs = Get-SshArgs $SshKeyPath

if ($SetupSshKey) {
  Ensure-SshKeyPair $SshKeyPath
  Install-PublicKey $remoteTarget ("${SshKeyPath}.pub") $sshArgs
}

if (-not (Test-SshNonInteractive $remoteTarget $sshArgs)) {
  $hint = @()
  $hint += "SSH key auth is not ready (would require password)."
  $hint += "Run once: .\\deploy.ps1 -SetupSshKey"
  $hint += "Or specify key explicitly: .\\deploy.ps1 -SshKeyPath `"$env:USERPROFILE\\.ssh\\id_ed25519`" -SetupSshKey"
  throw ($hint -join "`n")
}

if (-not $SkipFrontendBuild) {
  Write-Host "== Frontend: yarn install + build =="
  if (Get-Command yarn -ErrorAction SilentlyContinue) {
    yarn --cwd "$adminDir" install
    yarn --cwd "$adminDir" build
  } else {
    Require-Command "npm"
    npm --prefix "$adminDir" install
    npm --prefix "$adminDir" run build
  }
}

Write-Host "== Upload frontend dist =="
scp @sshArgs -r "$adminDistDir" "${remoteTarget}:${RemoteRoot}/admin/"

Write-Host "== Upload backend .env file =="
$prodEnvFile = Join-Path $projectRoot '.env.production'
if (-not (Test-Path $prodEnvFile)) {
  throw ".env.production file not found in project root. Please create it with production database credentials."
}
scp @sshArgs "$prodEnvFile" "${remoteTarget}:${RemoteRoot}/.env"

Write-Host "== Upload backend (exclude node_modules) =="
$tempTarBackend = [System.IO.Path]::GetTempFileName() + ".tar.gz"

# 打包后端，排除 node_modules
tar -czf "$tempTarBackend" -C "$serverDir" --exclude='node_modules' .

scp @sshArgs "$tempTarBackend" "${remoteTarget}:${RemoteRoot}/server.tar.gz"
Remove-Item -Force "$tempTarBackend" -ErrorAction SilentlyContinue

if (-not $SkipAgentsDeploy) {
  Write-Host "== Upload agents (python service) =="
  $tempTarAgents = [System.IO.Path]::GetTempFileName() + ".tar.gz"

  # 打包 agents，排除缓存与编译产物
  tar -czf "$tempTarAgents" -C "$agentsDir" --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' --exclude='.venv' .

  scp @sshArgs "$tempTarAgents" "${remoteTarget}:${RemoteRoot}/agents.tar.gz"
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
  $remoteCmd += "command -v pm2 >/dev/null 2>&1 || (echo 'pm2 not found on server' && exit 1)"
  # Ensure pm2 process exists; then restart by name.
  $remoteCmd += "pm2 describe '$Pm2Name' >/dev/null 2>&1 || pm2 start dist/index.js --name '$Pm2Name'; pm2 restart '$Pm2Name'"
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

  # Ensure pm2 process exists for agents; then restart by name.
  $remoteCmd += "pm2 describe '$AgentsPm2Name' >/dev/null 2>&1 || pm2 start .venv/bin/python --name '$AgentsPm2Name' -- -m uvicorn main:app --host 0.0.0.0 --port " + '${AGENTS_PORT:-8009}' + "; pm2 restart '$AgentsPm2Name'"
  $remoteCmd += "pm2 save || true"
}

Write-Host "== Remote: install/build/restart =="
ssh @sshArgs "$remoteTarget" ($remoteCmd -join "; ")

Write-Host "Done."
