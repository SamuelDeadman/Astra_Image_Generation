data "google_project" "current" {
  project_id = var.project_id
}

locals {
  app_runtime_member    = "serviceAccount:${google_service_account.app_runtime.email}"
  task_invoker_member   = "serviceAccount:${google_service_account.task_invoker.email}"
  worker_runtime_member = "serviceAccount:${google_service_account.worker_runtime.email}"

  runtime_secret_accessors = merge(
    {
      for secret_key, secret_id in var.secret_resource_ids :
      "app-runtime-${secret_key}" => {
        member    = local.app_runtime_member
        secret_id = secret_id
      }
    },
    {
      for secret_key, secret_id in var.worker_secret_resource_ids :
      "worker-runtime-${secret_key}" => {
        member    = local.worker_runtime_member
        secret_id = secret_id
      }
    }
  )
}

resource "google_service_account" "app_runtime" {
  project      = var.project_id
  account_id   = var.app_runtime_service_account_id
  display_name = "AstraFlow Cloud Run app runtime"
  description  = "Runtime identity for the Next.js web application."
}

resource "google_service_account" "task_invoker" {
  project      = var.project_id
  account_id   = var.task_invoker_service_account_id
  display_name = "AstraFlow Cloud Tasks invoker"
  description  = "OIDC identity used by Cloud Tasks when invoking generation workers."
}

resource "google_service_account" "worker_runtime" {
  project      = var.project_id
  account_id   = var.worker_runtime_service_account_id
  display_name = "AstraFlow generation worker runtime"
  description  = "Runtime identity for the private Node generation lifecycle and provider worker."
}

resource "google_project_iam_member" "app_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = local.app_runtime_member
}

resource "google_project_iam_member" "app_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = local.app_runtime_member
}

resource "google_project_iam_member" "worker_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = local.worker_runtime_member
}

resource "google_project_iam_member" "worker_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = local.worker_runtime_member
}

resource "google_project_iam_member" "app_tasks_enqueuer" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = local.app_runtime_member
}

resource "google_secret_manager_secret_iam_member" "runtime_secret_accessor" {
  for_each = local.runtime_secret_accessors

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value.member
}

resource "google_storage_bucket_iam_member" "app_input_object_admin" {
  bucket = var.input_bucket_name
  role   = "roles/storage.objectAdmin"
  member = local.app_runtime_member
}

resource "google_storage_bucket_iam_member" "app_output_object_viewer" {
  bucket = var.output_bucket_name
  role   = "roles/storage.objectViewer"
  member = local.app_runtime_member
}

resource "google_storage_bucket_iam_member" "app_temp_object_admin" {
  bucket = var.temp_bucket_name
  role   = "roles/storage.objectAdmin"
  member = local.app_runtime_member
}

resource "google_storage_bucket_iam_member" "worker_input_object_viewer" {
  bucket = var.input_bucket_name
  role   = "roles/storage.objectViewer"
  member = local.worker_runtime_member
}

resource "google_storage_bucket_iam_member" "worker_output_object_admin" {
  bucket = var.output_bucket_name
  role   = "roles/storage.objectAdmin"
  member = local.worker_runtime_member
}

resource "google_storage_bucket_iam_member" "worker_temp_object_admin" {
  bucket = var.temp_bucket_name
  role   = "roles/storage.objectAdmin"
  member = local.worker_runtime_member
}

resource "google_artifact_registry_repository_iam_member" "app_artifact_reader" {
  project    = var.project_id
  location   = var.artifact_registry_location
  repository = var.artifact_registry_repository_id
  role       = "roles/artifactregistry.reader"
  member     = local.app_runtime_member
}

resource "google_artifact_registry_repository_iam_member" "worker_artifact_reader" {
  project    = var.project_id
  location   = var.artifact_registry_location
  repository = var.artifact_registry_repository_id
  role       = "roles/artifactregistry.reader"
  member     = local.worker_runtime_member
}

resource "google_kms_crypto_key_iam_member" "app_kms_encrypter_decrypter" {
  crypto_key_id = var.kms_crypto_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.app_runtime_member
}

resource "google_kms_crypto_key_iam_member" "worker_kms_encrypter_decrypter" {
  crypto_key_id = var.kms_crypto_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = local.worker_runtime_member
}

# Needed for V4 signed Cloud Storage URLs when using metadata-server credentials.
resource "google_service_account_iam_member" "app_can_sign_as_self" {
  service_account_id = google_service_account.app_runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.app_runtime_member
}

# The app enqueues Cloud Tasks using this OIDC service account.
resource "google_service_account_iam_member" "app_can_act_as_task_invoker" {
  service_account_id = google_service_account.task_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.app_runtime_member
}

# Cloud Tasks service agent mints OIDC tokens for HTTP task delivery.
resource "google_service_account_iam_member" "cloud_tasks_service_agent_token_creator" {
  service_account_id = google_service_account.task_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
}

# Only the private worker invokes managed inference. No user-provided cloud key.
resource "google_project_iam_custom_role" "worker_vertex_predict" {
  project     = var.project_id
  role_id     = "${replace(var.worker_runtime_service_account_id, "-", "_")}_predict"
  title       = "AstraFlow worker managed inference"
  description = "Minimum permission required to call reviewed Google publisher models."
  permissions = ["aiplatform.endpoints.predict"]
}

resource "google_project_iam_member" "worker_vertex_predict" {
  project = var.project_id
  role    = google_project_iam_custom_role.worker_vertex_predict.name
  member  = local.worker_runtime_member
}
