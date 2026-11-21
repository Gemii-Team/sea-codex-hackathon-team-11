variable "instance_alias" {
  description = "Connect instance alias and admin hostname (https://<alias>.my.connect.aws/). Must be unique across Connect in the Region. Changing it replaces the instance, which discards the widget configuration and counts against Connect's instance create/delete limits, so only change it after a failed create or a confirmed alias collision."
  type        = string
  default     = "sea-hackathon-team-11-web-call-5102"

  validation {
    condition     = can(regex("^sea-hackathon-team-11-[a-z0-9]+(-[a-z0-9]+)*$", var.instance_alias)) && length(var.instance_alias) <= 45
    error_message = "instance_alias must start with \"sea-hackathon-team-11-\", use only lowercase letters, digits and single hyphens, end with a letter or digit, and be at most 45 characters (the Connect CreateInstance limit)."
  }
}
