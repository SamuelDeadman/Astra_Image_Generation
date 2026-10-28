param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$SeedJobName,
  [Parameter(Mandatory = $true)][string]$BucketName
)
$ErrorActionPreference = 'Stop'
$modelLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../workers/gpu/model-lock.json') -Raw | ConvertFrom-Json
$cachePrefix = 'ollama/' + $modelLock.manifest_digest.Replace(':', '-')

# Explicit deployment/startup preparation. No command in this script runs during local tests.
& gcloud run jobs execute $SeedJobName --project $ProjectId --region $Region --wait --quiet
if ($LASTEXITCODE -ne 0) { throw 'The model cache preparation job did not succeed.' }
$markerText = & gcloud storage cat "gs://$BucketName/$cachePrefix/READY.json" --project $ProjectId
if ($LASTEXITCODE -ne 0) { throw 'The model cache completion marker is missing.' }
$marker = ($markerText -join "`n") | ConvertFrom-Json
if ($marker.model -ne $modelLock.model -or $marker.manifest_digest -ne $modelLock.manifest_digest -or $marker.version -ne 1) {
  throw 'The model cache marker does not match the fixed model snapshot.'
}
Write-Output "Verified GCP model cache: $($modelLock.model) ($($marker.blob_count) blobs)."
Write-Output 'Set ollama_model_cache_ready=true for the next reviewed Terraform apply.'
Write-Output 'Image inference still requires a compatible Linux Ollama runtime and successful verify:model:live.'
