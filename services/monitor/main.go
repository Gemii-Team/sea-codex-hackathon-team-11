package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"wirachit/cloud-orchestrator/internal/service"
)

type reading struct {
	Available bool      `json:"available"`
	CheckedAt time.Time `json:"checkedAt"`
}

func check(ctx context.Context, client *http.Client, endpoint string) reading {
	result := reading{CheckedAt: time.Now().UTC()}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return result
	}
	response, err := client.Do(request)
	if err != nil {
		return result
	}
	defer response.Body.Close()
	result.Available = response.StatusCode == http.StatusOK
	return result
}

func main() {
	endpoint := service.Env("API_HEALTH_URL", "http://localhost:8080/healthz")
	client := &http.Client{Timeout: 2 * time.Second}
	routes := http.NewServeMux()
	routes.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(check(r.Context(), client, endpoint))
	})
	routes.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		value := 0
		if check(r.Context(), client, endpoint).Available {
			value = 1
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		fmt.Fprintf(w, "# HELP orchestrator_api_up API health endpoint availability.\n# TYPE orchestrator_api_up gauge\norchestrator_api_up %d\n", value)
	})
	service.Run(service.Env("MONITOR_ADDR", "127.0.0.1:8081"), routes)
}
