param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$Region,
    [Parameter(Mandatory = $true)][string]$SeedJobName,
    [Parameter(Mandatory = $true)][string]$BucketName
)
$ErrorActionPreference = "Stop"
$catalogueSha = "8e6d29fa26321aaf9232249d77e5b13847e453e88cf3c6781bea9bd9272cb6fc"

# Explicit deployment/startup preparation; no GPU is allocated by this command.
& gcloud run jobs execute $SeedJobName --project=$ProjectId --region=$Region --wait --quiet
if ($LASTEXITCODE -ne 0) { throw "Hugging Face cache preparation failed. Inference must remain disabled." }
$markerJson = & gcloud storage cat "gs://$BucketName/huggingface/$catalogueSha/READY.json" --project=$ProjectId
if ($LASTEXITCODE -ne 0) { throw "The Hugging Face cache readiness marker is missing." }
$marker = ($markerJson -join "`n") | ConvertFrom-Json
if ($marker.version -ne 1 -or $marker.catalogue_sha256 -ne $catalogueSha) { throw "The cached catalogue does not match the reviewed model pins." }
$cataloguePath = Join-Path $PSScriptRoot "../src/lib/models/huggingface-models.json"
$catalogue = Get-Content -LiteralPath $cataloguePath -Raw | ConvertFrom-Json
foreach ($model in $catalogue.models) {
    $cached = $marker.models.PSObject.Properties[$model.id].Value
    if ($cached.revision -ne $model.revision -or $cached.files.Count -lt 1) { throw "A pinned Hugging Face snapshot is incomplete." }
}
Write-Output "Both Hugging Face model snapshots are cached. Apply with huggingface_model_cache_ready=true and huggingface_image_generation_enabled=true, then run live verification for each model."
