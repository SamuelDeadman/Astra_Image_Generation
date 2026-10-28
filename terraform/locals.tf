locals {
  normalized_app_name    = replace(lower(var.app_name), "/[^a-z0-9-]/", "-")
  normalized_environment = replace(lower(var.environment), "/[^a-z0-9-]/", "-")
  normalized_project_id  = replace(lower(var.project_id), "/[^a-z0-9-]/", "-")
  name_prefix            = "${local.normalized_app_name}-${local.normalized_environment}"

  common_labels = merge(
    {
      app         = local.normalized_app_name
      environment = local.normalized_environment
      managed_by  = "terraform"
    },
    var.labels
  )

  artifact_registry_repository_id = coalesce(var.artifact_registry_repository_id, "${local.name_prefix}-images")
  cloud_run_service_name          = coalesce(var.cloud_run_service_name, "${local.name_prefix}-web")
  gpu_worker_service_name         = coalesce(var.gpu_worker_service_name, "${local.name_prefix}-gpu-worker")
  generation_worker_service_name  = coalesce(var.generation_worker_service_name, "${local.name_prefix}-generation-worker")
  generation_worker_image         = coalesce(var.generation_worker_container_image, var.container_image)
  cloud_tasks_queue_name          = coalesce(var.cloud_tasks_queue_name, "${local.name_prefix}-generation")
  kms_keyring_name                = coalesce(var.kms_keyring_name, "${local.name_prefix}-keys")
  kms_crypto_key_name             = coalesce(var.kms_crypto_key_name, "credential-envelope")
  gpu_worker_audience             = var.gpu_worker_audience != "" ? var.gpu_worker_audience : "https://run.googleapis.com/projects/${var.project_id}/locations/${var.region}/services/${local.gpu_worker_service_name}"
  # Preserve the existing task audience and model-verification fingerprints after the service split.
  generation_worker_audience = var.worker_audience != "" ? var.worker_audience : local.gpu_worker_audience
  ollama_audience            = var.ollama_audience != "" ? var.ollama_audience : "https://run.googleapis.com/projects/${var.project_id}/locations/${var.region}/services/${local.gpu_worker_service_name}/ollama"
  legacy_node_enabled        = var.gpu_worker_runtime == "legacy-node"

  # Operator-selected model metadata only; this does not install or activate a model.
  ollama_model_selection = jsondecode(file("${path.module}/ollama-model-selection.json"))
  ollama_container_digest = try(regex("sha256:[a-f0-9]{64}$", var.gpu_worker_container_image), "")
  ollama_admission_environment = var.ollama_image_generation_enabled ? {
    OLLAMA_IMAGE_GENERATION_ENABLED = "true"
    OLLAMA_CONTAINER_DIGEST         = local.ollama_container_digest
    OLLAMA_MODEL_DIGEST             = var.ollama_model_digest
    OLLAMA_MODEL_CACHE_READY        = tostring(var.ollama_model_cache_ready)
    OLLAMA_DEPLOYMENT_FINGERPRINT   = sha256(jsonencode({
      audience        = local.ollama_audience
      containerDigest = local.ollama_container_digest
      modelDigest     = var.ollama_model_digest
      serviceUrl      = trimsuffix(var.ollama_service_url, "/")
    }))
  } : { OLLAMA_IMAGE_GENERATION_ENABLED = "false" }

  bucket_names = {
    input  = coalesce(try(var.bucket_name_overrides.input, null), "${local.name_prefix}-${local.normalized_project_id}-input")
    output = coalesce(try(var.bucket_name_overrides.output, null), "${local.name_prefix}-${local.normalized_project_id}-output")
    temp   = coalesce(try(var.bucket_name_overrides.temp, null), "${local.name_prefix}-${local.normalized_project_id}-temp")
  }

  service_account_ids = {
    app_runtime    = coalesce(try(var.service_account_ids.app_runtime, null), "${local.name_prefix}-app")
    task_invoker   = coalesce(try(var.service_account_ids.task_invoker, null), "${local.name_prefix}-tasks")
    worker_runtime = coalesce(try(var.service_account_ids.worker_runtime, null), "${local.name_prefix}-worker")
  }

  required_project_services = [
    "run.googleapis.com",
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudkms.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "iam.googleapis.com",
    "serviceusage.googleapis.com",
    "compute.googleapis.com",
    "vpcaccess.googleapis.com"
  ]

  cloud_run_environment_variables = merge(
    local.ollama_admission_environment,
    local.hf_admission_environment,
    {
      NODE_ENV                             = "production"
      ASTRAFLOW_RUNTIME_ROLE               = "web"
      GOOGLE_CLIENT_ID                     = var.next_public_google_client_id
      MONGODB_DB_NAME                      = var.mongodb_db_name
      MONGODB_APP_NAME                     = var.mongodb_app_name
      MONGODB_SERVER_API_VERSION           = "1"
      MONGODB_AUTO_ENSURE_INDEXES          = "false"
      GCP_PROJECT_ID                       = var.project_id
      VERTEX_AI_LOCATION                   = "global"
      GOOGLE_CLOUD_PROJECT                 = var.project_id
      GCS_INPUT_BUCKET                     = local.bucket_names.input
      GCS_OUTPUT_BUCKET                    = local.bucket_names.output
      GCS_BUCKET_INPUT                     = local.bucket_names.input
      GCS_BUCKET_OUTPUT                    = local.bucket_names.output
      GCP_TASKS_LOCATION                   = var.region
      GCP_TASKS_QUEUE                      = local.cloud_tasks_queue_name
      CLOUD_TASKS_QUEUE                    = local.cloud_tasks_queue_name
      GENERATION_WORKER_URL                = var.generation_worker_url != "" ? var.generation_worker_url : module.generation_worker.worker_endpoint
      WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL = module.iam.task_invoker_service_account_email
      WORKER_AUDIENCE                      = local.generation_worker_audience
      KMS_KEY_RESOURCE                     = module.kms.crypto_key_id
      MONGODB_ATLAS_PROJECT_ID             = var.atlas_project_id
      MONGODB_APP_USER                     = var.mongodb_app_user
      GCS_TEMP_BUCKET                      = local.bucket_names.temp
      MAX_ACTIVE_GENERATIONS_PER_USER      = "3"
      MONGODB_SERVER_SELECTION_TIMEOUT_MS  = "5000"
      MONGODB_MAX_POOL_SIZE                = "20"
      MONGODB_MIN_POOL_SIZE                = "0"
    },
    var.gcp_gpu_execution_url != "" ? {
      GCP_GPU_EXECUTION_URL      = var.gcp_gpu_execution_url
      GCP_GPU_EXECUTION_AUDIENCE = var.gcp_gpu_execution_audience != "" ? var.gcp_gpu_execution_audience : var.gcp_gpu_execution_url
    } : {}
  )

  cloud_run_secret_environment_variables = merge(
    {
      SESSION_SECRET = {
        secret_id = module.secrets.secret_ids.session_secret
        version   = "latest"
      }
      MONGODB_URI = {
        secret_id = module.secrets.secret_ids.mongodb_uri
        version   = "latest"
      }
    },
    var.google_oauth_client_secret != null ? {
      GOOGLE_OAUTH_CLIENT_SECRET = {
        secret_id = module.secrets.secret_ids.google_oauth_client_secret
        version   = "latest"
      }
    } : {}
  )

  generation_worker_environment_variables = merge(
    local.ollama_admission_environment,
    local.hf_admission_environment,
    var.ollama_image_generation_enabled ? {
      OLLAMA_SERVICE_URL = trimsuffix(var.ollama_service_url, "/")
      OLLAMA_AUDIENCE    = local.ollama_audience
    } : {},
    var.huggingface_image_generation_enabled ? {
      HF_SERVICE_URL = local.hf_service_url
      HF_AUDIENCE    = local.hf_audience
    } : {},
    {
      NODE_ENV                             = "production"
      ASTRAFLOW_RUNTIME_ROLE               = "worker"
      MONGODB_DB_NAME                      = var.mongodb_db_name
      MONGODB_APP_NAME                     = "${var.mongodb_app_name}-gpu-worker"
      MONGODB_SERVER_API_VERSION           = "1"
      MONGODB_AUTO_ENSURE_INDEXES          = "false"
      GCP_PROJECT_ID                       = var.project_id
      VERTEX_AI_LOCATION                   = "global"
      GOOGLE_CLOUD_PROJECT                 = var.project_id
      GCS_INPUT_BUCKET                     = local.bucket_names.input
      GCS_OUTPUT_BUCKET                    = local.bucket_names.output
      GCS_TEMP_BUCKET                      = local.bucket_names.temp
      KMS_KEY_RESOURCE                     = module.kms.crypto_key_id
      WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL = module.iam.task_invoker_service_account_email
      WORKER_AUDIENCE                      = local.generation_worker_audience
      GENERATION_LOCAL_WORKER_ENABLED      = "false"
      MONGODB_SERVER_SELECTION_TIMEOUT_MS  = "5000"
      MONGODB_MAX_POOL_SIZE                = "10"
      MONGODB_MIN_POOL_SIZE                = "0"
    },
    var.gpu_worker_model_bucket_name != "" ? {
      GPU_MODEL_BUCKET = var.gpu_worker_model_bucket_name
    } : {}
  )

  generation_worker_secret_environment_variables = {
    MONGODB_URI = {
      secret_id = module.secrets.secret_ids.mongodb_uri
      version   = "latest"
    }
  }

  # Ollama receives only its verified read-only model snapshot and process settings.
  ollama_environment_variables = merge({
    OLLAMA_HOST              = "0.0.0.0:${var.gpu_worker_container_port}"
    OLLAMA_NUM_PARALLEL      = "1"
    OLLAMA_MAX_LOADED_MODELS = "1"
  }, var.ollama_model_cache_enabled && var.ollama_model_cache_ready ? {
    OLLAMA_MODELS  = "/models"
    OLLAMA_NOPRUNE = "true"
  } : {})
}
