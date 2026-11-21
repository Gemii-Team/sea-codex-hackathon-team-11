package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The public picker has exactly three fixed samples. Generate each once on the
// server and reuse its MP3 across devices and visits.
func registerVoiceSamples(routes *http.ServeMux, key string) {
	const greeting = "สวัสดีจ้ะ ยายมะลิรับสายจ้ะ หนูโทรมาเรื่องอะไรเหรอ"
	const dir = "/var/lib/wirachit"
	var lock sync.Mutex
	retryAfter := make(map[string]time.Time)
	routes.HandleFunc("GET /api/v1/voice/samples/{voice}", func(w http.ResponseWriter, r *http.Request) {
		voice := r.PathValue("voice")
		switch voice {
		case "marin", "cedar", "coral":
		default:
			http.NotFound(w, r)
			return
		}
		name := filepath.Join(dir, "sample-v2-"+voice+".mp3")
		lock.Lock()
		defer lock.Unlock()
		if _, err := os.Stat(name); os.IsNotExist(err) {
			if key == "" || time.Now().Before(retryAfter[voice]) {
				http.Error(w, "Sample temporarily unavailable", http.StatusServiceUnavailable)
				return
			}
			retryAfter[voice] = time.Now().Add(time.Hour)
			payload, _ := json.Marshal(map[string]string{
				"model": "gpt-4o-mini-tts", "voice": voice, "input": greeting,
				"instructions": "Speak natural, friendly Thai.", "response_format": "mp3",
			})
			req, _ := http.NewRequest(http.MethodPost, "https://api.openai.com/v1/audio/speech", bytes.NewReader(payload))
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Content-Type", "application/json")
			resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
			if err != nil {
				http.Error(w, "Voice generation failed", http.StatusBadGateway)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				http.Error(w, "Voice generation unavailable", http.StatusBadGateway)
				return
			}
			audio, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
			if err != nil || len(audio) < 256 || len(audio) == 2<<20 {
				http.Error(w, "Incomplete audio", http.StatusBadGateway)
				return
			}
			if err := os.WriteFile(name+".tmp", audio, 0600); err != nil {
				http.Error(w, "Sample storage unavailable", http.StatusInternalServerError)
				return
			}
			if err := os.Rename(name+".tmp", name); err != nil {
				http.Error(w, "Sample storage unavailable", http.StatusInternalServerError)
				return
			}
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.ServeFile(w, r, name)
	})
}
