FROM golang:1.25-alpine AS build
ARG SERVICE
WORKDIR /src
COPY go.mod ./
COPY internal/ internal/
COPY services/ services/
RUN CGO_ENABLED=0 go build -trimpath -o /service "./services/${SERVICE}"

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && install -d -o 65532 -g 65532 /var/lib/wirachit
COPY --from=build /service /service
USER 65532:65532
ENTRYPOINT ["/service"]
