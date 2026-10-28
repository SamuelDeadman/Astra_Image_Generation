# Non-secret production deployment values. Keep actual secrets out of this file.
project_id  = "replace-me-prod-project"
region      = "europe-west1"
environment = "prod"
app_name    = "astraflow"

artifact_registry_repository_id = "astraflow-prod-images"
container_image                 = "europe-west1-docker.pkg.dev/replace-me-prod-project/astraflow-prod-images/web:release"

next_public_google_client_id = ""

# MongoDB Atlas is external. Set the URI at apply time:
#   $env:TF_VAR_mongodb_atlas_uri = "<atlas-uri-from-secret-store>"
mongodb_db_name  = "astraflow_prod"
mongodb_app_name = "astraflow-image-studio-prod"
mongodb_app_user = "astraflow_prod_app"
atlas_project_id = "replace-me-atlas-project-id"

# Leave empty to use the separate private Node worker and the existing task audience.
generation_worker_url          = ""
worker_audience                = ""
generation_worker_service_name = null
# Supply the tested existing Node image digest; do not reuse the Ollama image.
generation_worker_container_image = "replace-me-prod-node-image@sha256:0000000000000000000000000000000000000000000000000000000000000000"
generation_worker_max_instances   = 2

# Resolve and test ollama/ollama:latest, then replace with ollama/ollama@sha256:<tested-digest>.
gpu_worker_container_image   = "replace-me-prod-ollama-image@sha256:0000000000000000000000000000000000000000000000000000000000000000"
gpu_worker_runtime           = "ollama" # Existing deployments MUST use the documented two-phase migration.
gpu_worker_enable_gpu        = false # Enable L4 explicitly only after operator quota/runtime review.
ollama_audience              = ""
gpu_worker_service_name      = null
gpu_worker_audience          = ""
gpu_worker_max_instances     = 2
gpu_worker_timeout_seconds   = 1800
gpu_worker_cpu               = "4"
gpu_worker_memory            = "16Gi"
gpu_worker_container_port    = 11434
gpu_worker_vpc_egress        = "PRIVATE_RANGES_ONLY"
gpu_worker_model_bucket_name = ""
gcp_gpu_execution_url        = ""
gcp_gpu_execution_audience   = ""

# Optional verified domain, for example "studio.example.com".
custom_domain = null

labels = {
  cost_center = "ai-image-platform"
  owner       = "platform"
  tier        = "production"
}

bucket_name_overrides = {}
service_account_ids   = {}

storage_force_destroy                 = false
input_asset_retention_days            = 30
output_asset_nearline_days            = 90
temp_asset_retention_days             = 7
output_retention_days                 = 30
create_vpc_connector                  = true
cloud_run_min_instances               = 1
cloud_run_max_instances               = 50
cloud_tasks_max_dispatches_per_second = 5
cloud_tasks_max_concurrent_dispatches = 25
monitoring_notification_emails        = []

# Separate Hugging Face image backend; immutable images and cache proof are required.
huggingface_enabled                    = false
huggingface_image_generation_enabled   = false
huggingface_model_cache_ready          = false
huggingface_container_image            = null
huggingface_cache_seed_container_image = null
huggingface_model_cache_bucket_name    = null
huggingface_max_instances              = 1
