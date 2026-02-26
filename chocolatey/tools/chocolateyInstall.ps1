$ErrorActionPreference = 'Stop'

$version = '1.9.3'

Write-Host "Installing vnxt v$version via npm..."
npm install -g vnxt@$version

if ($LASTEXITCODE -ne 0) {
    throw "npm install failed. Please ensure Node.js is installed. Run: choco install nodejs"
}

Write-Host "vnxt v$version installed successfully. Use 'vx --help' to get started."