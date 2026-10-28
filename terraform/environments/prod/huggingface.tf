variable "huggingface_enabled" {
  type    = bool
  default = false
}
variable "huggingface_image_generation_enabled" {
  type    = bool
  default = false
}
variable "huggingface_model_cache_ready" {
  type    = bool
  default = false
}
variable "huggingface_container_image" {
  type    = string
  default = null
}
variable "huggingface_cache_seed_container_image" {
  type    = string
  default = null
}
variable "huggingface_model_cache_bucket_name" {
  type    = string
  default = null
}
variable "huggingface_max_instances" {
  type    = number
  default = 1
}
output "huggingface" {
  value = module.platform.huggingface
}
