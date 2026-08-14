param(
  [Parameter(Mandatory = $true)]
  [string]$ServiceAccountJson
)

$ErrorActionPreference = 'Stop'

if (!(Test-Path -LiteralPath $ServiceAccountJson)) {
  throw "No existe el archivo: $ServiceAccountJson"
}

$serviceAccount = Get-Content -LiteralPath $ServiceAccountJson -Raw | ConvertFrom-Json
if (!$serviceAccount.client_email -or !$serviceAccount.private_key -or !$serviceAccount.project_id) {
  throw 'El JSON no parece ser una clave valida de cuenta de servicio de Firebase.'
}

$workerDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'worker'
Push-Location $workerDir
try {
  $serviceAccount.client_email | npx wrangler secret put GOOGLE_CLIENT_EMAIL
  $serviceAccount.private_key | npx wrangler secret put GOOGLE_PRIVATE_KEY
} finally {
  Pop-Location
}

Write-Host 'Secretos de Cloudflare configurados.'
