output "secret_ids" {
  description = "Secret Manager short IDs keyed by logical name."
  value = {
    for key, secret in google_secret_manager_secret.managed : key => secret.secret_id
  }
}

output "secret_resource_ids" {
  description = "Secret Manager resource IDs keyed by logical name."
  value = {
    for key, secret in google_secret_manager_secret.managed : key => secret.id
  }
}

output "session_secret_version_name" {
  description = "Created SESSION_SECRET version resource name, if Terraform manages it."
  value       = try(google_secret_manager_secret_version.session_secret[0].name, null)
}

output "mongodb_uri_version_name" {
  description = "Created MONGODB_URI version resource name, if Terraform manages it."
  value       = try(google_secret_manager_secret_version.mongodb_uri[0].name, null)
  sensitive   = true
}
