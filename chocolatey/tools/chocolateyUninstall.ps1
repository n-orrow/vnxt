$ErrorActionPreference = 'Stop'

Write-Host "Uninstalling vnxt..."
npm uninstall -g vnxt

if ($LASTEXITCODE -ne 0) {
    Write-Warning "npm uninstall returned an error. vnxt may not have been fully removed."
} else {
    Write-Host "vnxt uninstalled successfully."
}