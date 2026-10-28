output "queue_name" {
  description = "Cloud Tasks queue name."
  value       = google_cloud_tasks_queue.generation.name
}

output "queue_id" {
  description = "Cloud Tasks queue resource ID."
  value       = google_cloud_tasks_queue.generation.id
}

output "queue_location" {
  description = "Cloud Tasks queue location."
  value       = google_cloud_tasks_queue.generation.location
}
