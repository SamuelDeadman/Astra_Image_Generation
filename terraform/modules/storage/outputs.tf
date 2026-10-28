output "input_bucket_name" {
  description = "Input/reference asset bucket name."
  value       = google_storage_bucket.input_assets.name
}

output "output_bucket_name" {
  description = "Generated output asset bucket name."
  value       = google_storage_bucket.output_assets.name
}

output "temp_bucket_name" {
  description = "Temporary asset bucket name."
  value       = google_storage_bucket.temp_assets.name
}

output "input_bucket_url" {
  description = "Input bucket URL."
  value       = google_storage_bucket.input_assets.url
}

output "output_bucket_url" {
  description = "Output bucket URL."
  value       = google_storage_bucket.output_assets.url
}

output "temp_bucket_url" {
  description = "Temp bucket URL."
  value       = google_storage_bucket.temp_assets.url
}
