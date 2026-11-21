package main

import (
	"io"
	"log"
	"net/http"
	"net/url"
	"time"

	"wirachit/cloud-orchestrator/internal/service"
)

func main() {
	monitor, err := url.Parse(service.Env("MONITOR_URL", "http://localhost:8081"))
	if err != nil || monitor.Host == "" || (monitor.Scheme != "http" && monitor.Scheme != "https") {
		log.Fatal("invalid MONITOR_URL")
	}
	client := &http.Client{Timeout: 3 * time.Second}
	routes := http.NewServeMux()
	routes.HandleFunc("GET /api/v1/status", func(w http.ResponseWriter, r *http.Request) {
		request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, monitor.JoinPath("status").String(), nil)
		if err != nil {
			http.Error(w, "monitor configuration error", http.StatusInternalServerError)
			return
		}
		response, err := client.Do(request)
		if err != nil {
			http.Error(w, "monitor unavailable", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			http.Error(w, "monitor status request failed", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.Copy(w, response.Body)
	})
	service.Run(service.Env("API_ADDR", "127.0.0.1:8080"), routes)
}
