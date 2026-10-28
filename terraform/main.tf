module "project_bootstrap" {
  source = "./modules/project-bootstrap"

  project_id                  = var.project_id
  region                      = var.region
  labels                      = local.common_labels
  enable_project_services     = var.enable_project_services
  disable_services_on_destroy = var.disable_services_on_destroy
  required_services           = local.required_project_services

  artifact_registry_repository_id = local.artifact_registry_repository_id
  artifact_registry_format        = var.artifact_registry_format
}

module "networking" {
  source = "./modules/networking"

  project_id           = var.project_id
  region               = var.region
  name_prefix          = local.name_prefix
  labels               = local.common_labels
  create_vpc_connector = var.create_vpc_connector
  enable_cloud_nat     = var.ollama_image_generation_enabled || var.huggingface_image_generation_enabled
  connector_cidr_range = var.vpc_connector_cidr_range

  depends_on = [module.project_bootstrap]
}

module "storage" {
  source = "./modules/storage"

  project_id                 = var.project_id
  region                     = var.region
  labels                     = local.common_labels
  bucket_names               = local.bucket_names
  force_destroy              = var.storage_force_destroy
  input_asset_retention_days = var.input_asset_retention_days
  output_asset_nearline_days = var.output_asset_nearline_days
  temp_asset_retention_days  = var.temp_asset_retention_days
  output_retention_days      = var.output_retention_days

  depends_on = [module.project_bootstrap]
}

module "secrets" {
  source = "./modules/secrets"

  project_id                    = var.project_id
  name_prefix                   = local.name_prefix
  labels                        = local.common_labels
  create_secret_versions        = var.create_secret_versions
  session_secret_value          = var.session_secret_value
  generate_session_secret       = var.generate_session_secret
  mongodb_atlas_uri             = var.mongodb_atlas_uri
  google_oauth_client_secret    = var.google_oauth_client_secret
  additional_runtime_secret_ids = var.additional_runtime_secret_names

  depends_on = [module.project_bootstrap]
}

module "tasks" {
  source = "./modules/tasks"

  project_id                = var.project_id
  region                    = var.region
  queue_name                = local.cloud_tasks_queue_name
  max_dispatches_per_second = var.cloud_tasks_max_dispatches_per_second
  max_concurrent_dispatches = var.cloud_tasks_max_concurrent_dispatches
  max_attempts              = var.cloud_tasks_max_attempts
  labels                    = local.common_labels

  depends_on = [module.project_bootstrap]
}

module "kms" {
  source = "./modules/kms"

  project_id      = var.project_id
  region          = coalesce(var.kms_region, var.region)
  keyring_name    = local.kms_keyring_name
  crypto_key_name = local.kms_crypto_key_name
  labels          = local.common_labels

  depends_on = [module.project_bootstrap]
}

module "iam" {
  source = "./modules/iam"

  project_id                        = var.project_id
  region                            = var.region
  app_runtime_service_account_id    = local.service_account_ids.app_runtime
  task_invoker_service_account_id   = local.service_account_ids.task_invoker
  worker_runtime_service_account_id = local.service_account_ids.worker_runtime
  labels                            = local.common_labels
  secret_resource_ids               = module.secrets.secret_ids
  worker_secret_resource_ids        = {
    mongodb_uri = module.secrets.secret_ids.mongodb_uri
  }
  input_bucket_name               = module.storage.input_bucket_name
  output_bucket_name              = module.storage.output_bucket_name
  temp_bucket_name                = module.storage.temp_bucket_name
  artifact_registry_repository_id = module.project_bootstrap.artifact_registry_repository_short_id
  artifact_registry_location      = module.project_bootstrap.artifact_registry_location
  cloud_tasks_queue_id            = module.tasks.queue_id
  kms_crypto_key_id               = module.kms.crypto_key_id

  depends_on = [
    module.project_bootstrap,
    module.storage,
    module.secrets,
    module.tasks,
    module.kms
  ]
}

module "generation_worker" {
  source = "./modules/generation-worker"

  project_id                         = var.project_id
  region                             = var.region
  service_name                       = local.generation_worker_service_name
  labels                             = local.common_labels
  container_image                    = local.generation_worker_image
  service_account_email              = module.iam.worker_runtime_service_account_email
  task_invoker_service_account_email = module.iam.task_invoker_service_account_email
  audience                           = local.generation_worker_audience
  environment_variables              = local.generation_worker_environment_variables
  secret_environment_variables       = local.generation_worker_secret_environment_variables
  max_instances                      = var.generation_worker_max_instances
  vpc_connector_id                   = var.ollama_image_generation_enabled || var.huggingface_image_generation_enabled ? null : module.networking.vpc_connector_id
  direct_vpc_network                 = var.ollama_image_generation_enabled || var.huggingface_image_generation_enabled ? module.networking.network_id : null
  direct_vpc_subnetwork              = var.ollama_image_generation_enabled || var.huggingface_image_generation_enabled ? module.networking.subnetwork_id : null
  vpc_egress                         = var.ollama_image_generation_enabled || var.huggingface_image_generation_enabled ? "ALL_TRAFFIC" : "PRIVATE_RANGES_ONLY"

  depends_on = [module.iam, google_cloud_run_v2_service_iam_member.hf_node_invoker]
}

resource "google_service_account" "ollama_runtime" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-ollama"
  display_name = "AstraFlow private Ollama runtime"
  description  = "Read-only model cache; no application assets, secrets, KMS, MongoDB or Vertex permissions."

  depends_on = [module.project_bootstrap]
}

module "gpu_worker" {
  source = "./modules/gpu-worker"

  enable_gpu          = var.gpu_worker_enable_gpu
  legacy_node_enabled = local.legacy_node_enabled
  audience            = local.legacy_node_enabled ? local.generation_worker_audience : local.ollama_audience
  task_audience       = local.generation_worker_audience

  project_id                         = var.project_id
  region                             = var.region
  service_name                       = local.gpu_worker_service_name
  labels                             = local.common_labels
  container_image                    = local.legacy_node_enabled ? local.generation_worker_image : var.gpu_worker_container_image
  service_account_email              = local.legacy_node_enabled ? module.iam.worker_runtime_service_account_email : google_service_account.ollama_runtime.email
  task_invoker_service_account_email = module.iam.task_invoker_service_account_email
  environment_variables              = local.legacy_node_enabled ? local.generation_worker_environment_variables : local.ollama_environment_variables
  secret_environment_variables       = local.legacy_node_enabled ? local.generation_worker_secret_environment_variables : {}
  container_port                     = local.legacy_node_enabled ? var.gpu_worker_legacy_node_port : var.gpu_worker_container_port
  health_path                        = local.legacy_node_enabled ? "/healthz" : "/api/version"
  cpu                                = var.gpu_worker_cpu
  memory                             = var.gpu_worker_memory
  max_instances                      = var.gpu_worker_max_instances
  timeout_seconds                    = var.gpu_worker_timeout_seconds
  vpc_connector_id                   = module.networking.vpc_connector_id
  vpc_egress                         = var.gpu_worker_vpc_egress
  model_cache_bucket                = !local.legacy_node_enabled && var.ollama_model_cache_enabled && var.ollama_model_cache_ready ? google_storage_bucket.ollama_models[0].name : null
  model_cache_prefix                = local.ollama_cache_prefix
  model_cache_verified              = local.ollama_cache_verified

  # Switch the web producer to the ready Node worker before repurposing the old service.
  # Existing queues still require the documented two-phase drain migration.
  depends_on = [module.iam, module.cloud_run, google_storage_bucket_iam_member.ollama_model_reader]
}

resource "google_cloud_run_v2_service_iam_member" "ollama_node_invoker" {
  count    = var.ollama_image_generation_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = module.gpu_worker.service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.iam.worker_runtime_service_account_email}"

  lifecycle {
    precondition {
      condition     = var.ollama_model_cache_enabled && var.ollama_model_cache_ready && try(jsondecode(data.google_storage_bucket_object_content.ollama_cache_ready[0].content).manifest_digest == var.ollama_model_digest && jsondecode(data.google_storage_bucket_object_content.ollama_cache_ready[0].content).model == "x/flux2-klein:4b-fp8", false)
      error_message = "Run the cache preparation job and verify the fixed-model snapshot before activating inference."
    }
    precondition {
      condition     = var.ollama_model_digest == local.ollama_model_selection.manifest_digest
      error_message = "The model digest must match the code-owned FLUX.2 Klein 4B FP8 selection."
    }
    precondition {
      condition     = trimsuffix(var.ollama_service_url, "/") == module.gpu_worker.service_url
      error_message = "ollama_service_url must be the Ollama service created by this stack."
    }
    precondition {
      condition     = var.gpu_worker_runtime == "ollama" && var.gpu_worker_enable_gpu && var.create_vpc_connector
      error_message = "Ollama image inference requires the Ollama runtime, one L4 and the platform VPC network/subnet (create_vpc_connector=true)."
    }
    precondition {
      condition     = can(regex("^https://[a-z0-9.-]+\\.run\\.app/?$", var.ollama_service_url)) && can(regex("^sha256:[a-f0-9]{64}$", var.ollama_model_digest)) && local.ollama_container_digest != ""
      error_message = "Provide the private Ollama origin and immutable container/model digests before opting in."
    }
    precondition {
      condition = !contains([
        "sha256:265409e1d931028a8f7d5a32bcbafddd7bffbc6cc629d77efe9560adf692a5e7",
        "sha256:40c61dbf5091e0b4cc46f406f912fb061cfeca51208f0f7173c87c3b5f795c95"
      ], local.ollama_container_digest)
      error_message = "The inspected Ollama 0.40.6 image rejects image generation; a compatible live-verified image runtime is required."
    }
  }
}

resource "google_storage_bucket_iam_member" "worker_model_bucket_viewer" {
  count = var.gpu_worker_model_bucket_name != "" ? 1 : 0

  bucket = var.gpu_worker_model_bucket_name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${module.iam.worker_runtime_service_account_email}"
}

module "cloud_run" {
  source = "./modules/cloud-run"

  project_id                   = var.project_id
  region                       = var.region
  service_name                 = local.cloud_run_service_name
  labels                       = local.common_labels
  container_image              = var.container_image
  service_account_email        = module.iam.app_runtime_service_account_email
  environment_variables        = local.cloud_run_environment_variables
  secret_environment_variables = local.cloud_run_secret_environment_variables
  ingress                      = var.cloud_run_ingress
  allow_unauthenticated        = var.allow_unauthenticated
  cpu                          = var.cloud_run_cpu
  memory                       = var.cloud_run_memory
  min_instances                = var.cloud_run_min_instances
  max_instances                = var.cloud_run_max_instances
  timeout_seconds              = var.cloud_run_timeout_seconds
  vpc_connector_id             = module.networking.vpc_connector_id
  custom_domain                = var.custom_domain

  depends_on = [module.iam, module.generation_worker]
}

module "monitoring" {
  source = "./modules/monitoring"

  project_id             = var.project_id
  environment            = var.environment
  labels                 = local.common_labels
  cloud_run_service_name = module.cloud_run.service_name
  notification_emails    = var.monitoring_notification_emails
  log_sink_destination   = var.log_sink_destination

  depends_on = [module.cloud_run]
}
