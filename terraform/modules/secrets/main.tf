resource "random_password" "session_secret" {
  count = var.create_secret_versions && var.generate_session_secret && var.session_secret_value == null ? 1 : 0

  length  = 64
  special = true
}

locals {
  core_secret_ids = {
    session_secret             = "${var.name_prefix}-session-secret"
    mongodb_uri                = "${var.name_prefix}-mongodb-uri"
    google_oauth_client_secret = "${var.name_prefix}-google-oauth-client-secret"
  }

  additional_secret_ids = {
    for secret_id in var.additional_runtime_secret_ids : secret_id => secret_id
  }

  all_secret_ids           = merge(local.core_secret_ids, local.additional_secret_ids)
  effective_session_secret = var.session_secret_value != null ? var.session_secret_value : try(random_password.session_secret[0].result, null)
}

resource "google_secret_manager_secret" "managed" {
  for_each = local.all_secret_ids

  project   = var.project_id
  secret_id = each.value
  labels    = merge(var.labels, { secret_key = replace(each.key, "_", "-") })

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "session_secret" {
  count = var.create_secret_versions && (var.generate_session_secret || var.session_secret_value != null) ? 1 : 0

  secret      = google_secret_manager_secret.managed["session_secret"].id
  secret_data = local.effective_session_secret
}

resource "google_secret_manager_secret_version" "mongodb_uri" {
  count = var.create_secret_versions && var.mongodb_atlas_uri != null ? 1 : 0

  secret      = google_secret_manager_secret.managed["mongodb_uri"].id
  secret_data = var.mongodb_atlas_uri
}

resource "google_secret_manager_secret_version" "google_oauth_client_secret" {
  count = var.create_secret_versions && var.google_oauth_client_secret != null ? 1 : 0

  secret      = google_secret_manager_secret.managed["google_oauth_client_secret"].id
  secret_data = var.google_oauth_client_secret
}
