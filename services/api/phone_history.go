package main

import (
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

var phoneID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)

func registerPhoneHistory(routes *http.ServeMux, authorized func(*http.Request) bool, callOwner func(*http.Request, string) bool) func(string) bool {
	base := strings.TrimRight(os.Getenv("PHONE_HISTORY_URL"), "/")
	client := &http.Client{Timeout: 9 * time.Second}
	forward := func(method, operation string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("id")
			ownHistory := operation == "history" && (id == "demo-otp-request" || callOwner(r, id))
			if operation != "finish" && !ownHistory && !authorized(r) {
				http.Error(w, "Team access required", http.StatusUnauthorized)
				return
			}
			if id != "" && !phoneID.MatchString(id) {
				http.NotFound(w, r)
				return
			}
			if operation == "finish" && !callOwner(r, id) {
				http.Error(w, "Invalid call token", http.StatusForbidden)
				return
			}
			if base == "" {
				http.Error(w, "Phone history is unavailable", http.StatusServiceUnavailable)
				return
			}
			path := base + "/" + operation
			if id != "" {
				path += "/" + id
			}
			req, err := http.NewRequestWithContext(r.Context(), method, path, nil)
			if err != nil {
				http.Error(w, "Invalid history configuration", 500)
				return
			}
			if operation == "evidence" {
				req.Header.Set("Authorization", r.Header.Get("Authorization"))
			}
			resp, err := client.Do(req)
			if err != nil {
				http.Error(w, "Phone history unavailable", 502)
				return
			}
			defer resp.Body.Close()
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(resp.StatusCode)
			io.Copy(w, resp.Body)
		}
	}
	routes.HandleFunc("GET /api/v1/phone/history", forward("GET", "history"))
	routes.HandleFunc("GET /api/v1/phone/history/{id}", forward("GET", "history"))
	routes.HandleFunc("GET /api/v1/phone/evidence/{id}", forward("GET", "evidence"))
	routes.HandleFunc("POST /api/v1/phone/finish/{id}", forward("POST", "finish"))
	return func(id string) bool {
		if base == "" {
			return false
		}
		resp, err := client.Post(base+"/attach/"+id, "application/json", nil)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		return resp.StatusCode == http.StatusCreated
	}
}
