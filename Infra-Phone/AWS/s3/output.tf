output "bucket_name" {
  description = "Name of the configured private bucket."
  value       = aws_s3_bucket.this.id

  depends_on = [
    aws_s3_bucket_public_access_block.this,
    aws_s3_bucket_server_side_encryption_configuration.this,
    aws_s3_bucket_policy.https_only,
    aws_s3_bucket_lifecycle_configuration.this,
  ]
}
