# Non-secret development deployment values. Keep actual secrets out of this file.
project_id  = "astraflow-506913"
region      = "europe-west1"
kms_region  = "us-central1"
environment = "dev"
app_name    = "astraflow"

artifact_registry_repository_id = "astraflow-dev-images"
container_image                 = "europe-west1-docker.pkg.dev/astraflow-506913/astraflow-dev-images/web:latest"


next_public_google_client_id = "637755791464-a65c52haoq0rcrtoh91doiarcp1lsfcs.apps.googleusercontent.com"


mongodb_db_name  = "astraflow_dev"
mongodb_app_name = "astraflow-image-studio-dev"
mongodb_app_user = "samueldeadmanbusiness_db_user"
atlas_project_id = "6a91b8cd2a5a0299312c2b2b"

# Leave empty to use the separate private Node worker and the existing task audience.
generation_worker_url             = ""
worker_audience                   = ""
generation_worker_service_name    = null
generation_worker_container_image = null # Reuse the existing Node container_image above.
generation_worker_max_instances   = 1

# Development may use a mutable tag while iterating. Promote tested images by digest before production.
gpu_worker_container_image   = "ollama/ollama:latest"
gpu_worker_runtime           = "ollama" # Existing deployments MUST use the two-phase migration in terraform/README.md.
gpu_worker_enable_gpu        = false # Explicit operator opt-in for L4 allocation; no model route is enabled.
ollama_audience              = ""
gpu_worker_service_name      = null
gpu_worker_audience          = ""
gpu_worker_max_instances     = 1
gpu_worker_timeout_seconds   = 1800
gpu_worker_cpu               = "4"
gpu_worker_memory            = "16Gi"
gpu_worker_container_port    = 11434
gpu_worker_vpc_egress        = "PRIVATE_RANGES_ONLY"
gpu_worker_model_bucket_name = ""
gcp_gpu_execution_url        = ""
gcp_gpu_execution_audience   = ""

custom_domain = null

labels = {
  cost_center = "ai-image-platform"
  owner       = "platform"
}

bucket_name_overrides = {}
service_account_ids   = {}

storage_force_destroy                 = true
input_asset_retention_days            = 7
output_asset_nearline_days            = 30
temp_asset_retention_days             = 3
output_retention_days                 = 0
create_vpc_connector                  = false
cloud_run_min_instances               = 0
cloud_run_max_instances               = 5
cloud_tasks_max_dispatches_per_second = 1
cloud_tasks_max_concurrent_dispatches = 3
monitoring_notification_emails        = []

# Separate Hugging Face image backend; prepare the cache before enabling its L4.
huggingface_enabled                    = false
huggingface_image_generation_enabled   = false
huggingface_model_cache_ready          = false
huggingface_container_image            = null
huggingface_cache_seed_container_image = null
huggingface_model_cache_bucket_name    = null
huggingface_max_instances              = 1
