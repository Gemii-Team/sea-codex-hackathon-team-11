package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

const callDuration = 3 * time.Minute
const demoCallLimit = 25

func registerVoice(routes *http.ServeMux) {
	key := os.Getenv("OPENAI_API_KEY")
	code := os.Getenv("VOICE_DEMO_CODE")
	client := &http.Client{Timeout: 8 * time.Second}
	var lock sync.Mutex
	active := false
	routes.HandleFunc("POST /api/v1/voice/calls", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if key == "" || code == "" {
			http.Error(w, "Voice demo is unavailable", http.StatusServiceUnavailable)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Voice-Demo-Code")), []byte(code)) != 1 {
			http.Error(w, "Invalid demo access code", http.StatusUnauthorized)
			return
		}
		var input struct {
			SDP, Name, Persona, Objective, Greeting, Instructions, Question, Tone, Voice string
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input); err != nil ||
			!strings.HasPrefix(input.SDP, "v=0") || len(input.SDP) > 20<<10 ||
			len(input.Name+input.Persona+input.Objective+input.Greeting+input.Instructions+input.Question+input.Tone) > 9<<10 {
			http.Error(w, "Invalid call configuration", http.StatusBadRequest)
			return
		}
		switch input.Voice {
		case "marin", "cedar", "coral":
		default:
			http.Error(w, "Unsupported voice", http.StatusBadRequest)
			return
		}
		instructions := fmt.Sprintf(`คุณเป็นผู้ช่วย AI ในเดโมรับสายจำลอง พูดภาษาไทยและแจ้งว่าเป็น AI เปิดด้วยคำทักทายที่กำหนด ถามทีละข้อและกระชับ ถามต่อจากสิ่งที่ผู้โทรแจ้งเพื่อเก็บข้อมูลที่ใช้ตรวจสอบ เช่น ชื่อบริษัท ยอด และเลขอ้างอิง ห้ามขอรหัสผ่าน OTP หรือข้อมูลการเงินส่วนตัว ห้ามทำธุรกรรม
ชื่อ: %s
บุคลิก: %s
น้ำเสียง: %s
เป้าหมาย: %s
คำทักทาย: %s
คำถามแรก: %s
คำสั่งเพิ่มเติม: %s`, input.Name, input.Persona, input.Tone, input.Objective, input.Greeting, input.Question, input.Instructions)
		session, err := json.Marshal(map[string]any{
			"type": "realtime", "model": "gpt-realtime-2.1-mini",
			"instructions": instructions, "max_output_tokens": 400,
			"audio": map[string]any{"output": map[string]string{"voice": input.Voice}},
		})
		if err != nil {
			http.Error(w, "Invalid session settings", http.StatusBadRequest)
			return
		}
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		if form.WriteField("sdp", input.SDP) != nil || form.WriteField("session", string(session)) != nil || form.Close() != nil {
			http.Error(w, "Could not prepare call", http.StatusInternalServerError)
			return
		}
		lock.Lock()
		if active {
			lock.Unlock()
			http.Error(w, "A demo call is already reserved", http.StatusTooManyRequests)
			return
		}
		err = reserveVoiceCall()
		if err == nil {
			active = true
		}
		lock.Unlock()
		if err != nil {
			log.Printf("voice quota: %v", err)
			http.Error(w, "Voice demo quota is unavailable or exhausted", http.StatusTooManyRequests)
			return
		}
		release := func() {
			lock.Lock()
			active = false
			lock.Unlock()
		}
		// Keep the upstream request alive if the browser leaves before receiving the SDP,
		// so the server can still schedule closure for the created call.
		req, _ := http.NewRequest(http.MethodPost, "https://api.openai.com/v1/realtime/calls", &body)
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", form.FormDataContentType())
		response, err := client.Do(req)
		if err != nil {
			time.AfterFunc(callDuration, release)
			http.Error(w, "OpenAI call request failed", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			release()
			log.Printf("OpenAI call creation: HTTP %d, request %s", response.StatusCode, response.Header.Get("X-Request-Id"))
			http.Error(w, "OpenAI could not start this call", http.StatusBadGateway)
			return
		}
		id := path.Base(response.Header.Get("Location"))
		if !strings.HasPrefix(id, "rtc_") || strings.ContainsAny(id, "/?#%") {
			time.AfterFunc(callDuration, release)
			http.Error(w, "OpenAI call ID missing", http.StatusBadGateway)
			return
		}
		time.AfterFunc(callDuration, func() {
			defer release()
			for attempt := 0; attempt < 3; attempt++ {
				req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost,
					"https://api.openai.com/v1/realtime/calls/"+id+"/hangup", nil)
				req.Header.Set("Authorization", "Bearer "+key)
				response, err := client.Do(req)
				if err == nil {
					response.Body.Close()
					if response.StatusCode < 300 || response.StatusCode == http.StatusNotFound {
						return
					}
				}
				time.Sleep(time.Second)
			}
			log.Print("OpenAI call cleanup did not confirm hangup")
		})
		w.Header().Set("Content-Type", "application/sdp")
		_, _ = io.Copy(w, io.LimitReader(response.Body, 32<<10))
	})
}

// This stack runs one API replica. Persist reservations on its durable volume.
func reserveVoiceCall() error {
	const file = "/var/lib/wirachit/voice-call-count"
	value, err := os.ReadFile(file)
	count := 0
	if err == nil {
		count, err = strconv.Atoi(string(value))
		if err != nil || count < 0 {
			return fmt.Errorf("invalid voice call count")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if count >= demoCallLimit {
		return fmt.Errorf("demo call limit reached")
	}
	if err := os.WriteFile(file+".next", []byte(strconv.Itoa(count+1)), 0600); err != nil {
		return err
	}
	return os.Rename(file+".next", file)
}
