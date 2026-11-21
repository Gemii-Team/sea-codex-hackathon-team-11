# Stand-in until the real app exists: proves build -> ECR -> SSM -> compose -> tunnel -> HTTPS.
# nginxinc/nginx-unprivileged:alpine as of 2026-11-21 (listens on 8080, runs as non-root)
FROM nginxinc/nginx-unprivileged@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 8080
