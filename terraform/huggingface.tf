# Separate Linux/CUDA image backend. Ollama resources and model selection are preserved.
variable "huggingface_enabled" {
  description = "Create the private Hugging Face model cache and preparation infrastructure."
  type        = bool
  default     = false
}
variable "huggingface_image_generation_enabled" {
  description = "Deploy the L4 inference service after the cache preparation job succeeds."
  type        = bool
  default     = false
}
variable "huggingface_model_cache_ready" {
  type    = bool
  default = false
}
variable "huggingface_container_image" {
  description = "Custom workers/huggingface/Dockerfile image, pinned by immutable digest."
  type        = string
  default     = null
  validation {
    condition     = var.huggingface_container_image == null || can(regex("@sha256:[a-f0-9]{64}$", var.huggingface_container_image))
    error_message = "Pin the built Hugging Face image by digest."
  }
}
variable "huggingface_cache_seed_container_image" {
  description = "CPU-only workers/huggingface/Dockerfile.cache image, pinned by digest."
  type        = string
  default     = null
  validation {
    condition     = var.huggingface_cache_seed_container_image == null || can(regex("@sha256:[a-f0-9]{64}$", var.huggingface_cache_seed_container_image))
    error_message = "Pin the cache-preparation image by digest."
  }
}
variable "huggingface_model_cache_bucket_name" {
  type    = string
  default = null
}
variable "huggingface_max_instances" {
  type    = number
  default = 1
  validation {
    condition     = var.huggingface_max_instances >= 1 && var.huggingface_max_instances <= 10 && floor(var.huggingface_max_instances) == var.huggingface_max_instances
    error_message = "Use between one and ten L4 instances."
  }
}

locals {
  hf_catalogue       = jsondecode(file("${path.module}/../src/lib/models/huggingface-models.json"))
  hf_catalogue_sha   = sha256(jsonencode(local.hf_catalogue))
  hf_cache_prefix    = "huggingface/${local.hf_catalogue_sha}"
  hf_service_name    = "${local.name_prefix}-hf-image"
  hf_audience        = "https://run.googleapis.com/projects/${var.project_id}/locations/${var.region}/services/${local.hf_service_name}/diffusers"
  hf_seed_enabled    = var.huggingface_enabled && var.huggingface_cache_seed_container_image != null
  hf_cache_verified  = var.huggingface_enabled && var.huggingface_model_cache_ready && try(
    jsondecode(data.google_storage_bucket_object_content.hf_ready[0].content).version == 1 &&
    jsondecode(data.google_storage_bucket_object_content.hf_ready[0].content).catalogue_sha256 == local.hf_catalogue_sha &&
    length(jsondecode(data.google_storage_bucket_object_content.hf_ready[0].content).models) == length(local.hf_catalogue.models) &&
    alltrue([for model in local.hf_catalogue.models : jsondecode(data.google_storage_bucket_object_content.hf_ready[0].content).models[model.id].revision == model.revision]), false)
  hf_container_digest = try(regex("sha256:[a-f0-9]{64}$", var.huggingface_container_image), "")
  hf_service_url      = var.huggingface_image_generation_enabled ? google_cloud_run_v2_service.hf_image[0].uri : ""
  hf_admission_environment = var.huggingface_image_generation_enabled ? {
    HF_IMAGE_GENERATION_ENABLED = "true"
    HF_MODEL_CACHE_READY        = tostring(local.hf_cache_verified)
    HF_MODEL_CATALOGUE_SHA256   = local.hf_catalogue_sha
    HF_CONTAINER_DIGEST         = local.hf_container_digest
    HF_DEPLOYMENT_FINGERPRINT   = sha256(jsonencode({
      audience        = local.hf_audience
      catalogueSha256 = local.hf_catalogue_sha
      containerDigest = local.hf_container_digest
      serviceUrl      = local.hf_service_url
    }))
  } : { HF_IMAGE_GENERATION_ENABLED = "false" }
}

resource "google_storage_bucket" "hf_models" {
  count                       = var.huggingface_enabled ? 1 : 0
  project                     = var.project_id
  name                        = coalesce(var.huggingface_model_cache_bucket_name, "${local.name_prefix}-${local.normalized_project_id}-hf-models")
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.common_labels
  versioning { enabled = true }
  depends_on = [module.project_bootstrap]
}

resource "google_service_account" "hf_runtime" {
  count        = var.huggingface_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "${local.name_prefix}-hf"
  display_name = "Read-only Hugging Face L4 runtime"
  depends_on   = [module.project_bootstrap]
}
resource "google_service_account" "hf_seed" {
  count        = local.hf_seed_enabled ? 1 : 0
  project      = var.project_id
  account_id   = "${local.name_prefix}-hf-seed"
  display_name = "Prepare pinned Hugging Face snapshots"
  depends_on   = [module.project_bootstrap]
}
resource "google_storage_bucket_iam_member" "hf_model_reader" {
  count  = var.huggingface_enabled ? 1 : 0
  bucket = google_storage_bucket.hf_models[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.hf_runtime[0].email}"
}
resource "google_storage_bucket_iam_member" "hf_seed_reader" {
  count  = local.hf_seed_enabled ? 1 : 0
  bucket = google_storage_bucket.hf_models[0].name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.hf_seed[0].email}"
}
resource "google_storage_bucket_iam_member" "hf_seed_creator" {
  count  = local.hf_seed_enabled ? 1 : 0
  bucket = google_storage_bucket.hf_models[0].name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.hf_seed[0].email}"
}
resource "google_cloud_run_v2_job" "hf_cache_seed" {
  count               = local.hf_seed_enabled ? 1 : 0
  project             = var.project_id
  name                = "${local.name_prefix}-hf-cache-seed"
  location            = var.region
  deletion_protection = false
  labels              = local.common_labels
  template {
    parallelism = 1
    task_count  = 1
    template {
      service_account = google_service_account.hf_seed[0].email
      timeout         = "7200s"
      max_retries     = 1
      containers {
        image = var.huggingface_cache_seed_container_image
        resources { limits = { cpu = "8", memory = "32Gi" } }
        env {
          name  = "CACHE_BUCKET"
          value = google_storage_bucket.hf_models[0].name
        }
        env {
          name  = "HF_MODEL_CATALOGUE_SHA256"
          value = local.hf_catalogue_sha
        }
      }
    }
  }
  depends_on = [google_storage_bucket_iam_member.hf_seed_reader, google_storage_bucket_iam_member.hf_seed_creator]
}
data "google_storage_bucket_object_content" "hf_ready" {
  count  = var.huggingface_enabled && var.huggingface_model_cache_ready ? 1 : 0
  bucket = google_storage_bucket.hf_models[0].name
  name   = "${local.hf_cache_prefix}/READY.json"
}

resource "google_cloud_run_v2_service" "hf_image" {
  count                = var.huggingface_image_generation_enabled ? 1 : 0
  provider             = google-beta
  project              = var.project_id
  location             = var.region
  name                 = local.hf_service_name
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = false
  custom_audiences     = [local.hf_audience]
  deletion_protection  = false
  launch_stage         = "BETA"
  labels               = local.common_labels
  lifecycle {
    precondition {
      condition     = local.hf_cache_verified && var.huggingface_container_image != null && var.create_vpc_connector
      error_message = "Prepare both pinned HF snapshots, provide the inference image digest and enable the platform VPC before activating the L4."
    }
  }
  template {
    service_account                  = google_service_account.hf_runtime[0].email
    timeout                          = "1800s"
    max_instance_request_concurrency = 1
    gpu_zonal_redundancy_disabled    = true
    scaling {
      min_instance_count = 0
      max_instance_count = var.huggingface_max_instances
    }
    node_selector { accelerator = "nvidia-l4" }
    containers {
      image = var.huggingface_container_image
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "8", memory = "32Gi", "nvidia.com/gpu" = "1" }
        cpu_idle          = false
        startup_cpu_boost = true
      }
      volume_mounts {
        name       = "hf-models"
        mount_path = "/models"
      }
      dynamic "env" {
        for_each = { HF_HUB_OFFLINE = "1", TRANSFORMERS_OFFLINE = "1", HF_HUB_DISABLE_IMPLICIT_TOKEN = "1", MODEL_CACHE_ROOT = "/models" }
        content {
          name  = env.key
          value = env.value
        }
      }
      startup_probe {
        timeout_seconds   = 2
        period_seconds    = 5
        failure_threshold = 48
        http_get {
          path = "/healthz"
          port = 8080
        }
      }
      liveness_probe {
        timeout_seconds   = 5
        period_seconds    = 30
        failure_threshold = 3
        http_get {
          path = "/healthz"
          port = 8080
        }
      }
    }
    volumes {
      name = "hf-models"
      gcs {
        bucket        = google_storage_bucket.hf_models[0].name
        read_only     = true
        mount_options = ["only-dir=${local.hf_cache_prefix}", "implicit-dirs", "file-cache:max-size-mb=0", "stat-cache-max-size-mb=32", "type-cache-max-size-mb=8"]
      }
    }
    vpc_access {
      network_interfaces {
        network    = module.networking.network_id
        subnetwork = module.networking.subnetwork_id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
  }
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
  depends_on = [google_storage_bucket_iam_member.hf_model_reader]
}
resource "google_cloud_run_v2_service_iam_member" "hf_node_invoker" {
  count    = var.huggingface_image_generation_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.hf_image[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.iam.worker_runtime_service_account_email}"
}
output "huggingface" {
  value = {
    service_url    = local.hf_service_url
    audience       = local.hf_audience
    bucket         = var.huggingface_enabled ? google_storage_bucket.hf_models[0].name : null
    prefix         = local.hf_cache_prefix
    cache_ready    = local.hf_cache_verified
    catalogue_sha  = local.hf_catalogue_sha
    seed_job       = local.hf_seed_enabled ? google_cloud_run_v2_job.hf_cache_seed[0].name : null
    model_options  = local.hf_catalogue.models
    admission_env  = local.hf_admission_environment
  }
}
