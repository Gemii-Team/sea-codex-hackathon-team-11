package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
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
	authorized := func(r *http.Request) bool {
		return code != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Voice-Demo-Code")), []byte(code)) == 1
	}
	recordingToken := func(id string) string {
		mac := hmac.New(sha256.New, []byte(code))
		_, _ = io.WriteString(mac, id)
		return hex.EncodeToString(mac.Sum(nil))
	}
	attachPhoneHistory := registerPhoneHistory(routes, authorized, recordingToken)
	registerVoiceSamples(routes, key)
	registerVoiceRecordings(routes, authorized, recordingToken)
	var lock sync.Mutex
	active := false
	routes.HandleFunc("POST /api/v1/voice/calls", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if key == "" || code == "" {
			http.Error(w, "Voice demo is unavailable", http.StatusServiceUnavailable)
			return
		}
		if !authorized(r) {
			http.Error(w, "Invalid demo access code", http.StatusUnauthorized)
			return
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(22 * time.Second))
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
		instructions := fmt.Sprintf(`คุณรับบทเป็นผู้รับสายในแบบฝึกรับมือมิจฉาชีพภาษาไทย ผู้โทรเล่นบทผู้ที่พยายามหลอกลวง เปิดด้วยคำทักทายที่กำหนด พูดเป็นธรรมชาติตามบุคลิก ฟังข้ออ้างแล้วถามต่อทีละเรื่อง เช่น ติดต่อจากที่ไหน เกี่ยวกับรายการอะไร มีเลขอ้างอิงให้ตรวจสอบไหม บันทึกสิ่งที่ผู้โทรกล่าวโดยไม่ฟันธงว่าเป็นความจริง อย่าเสนอขายบริการหรือถามว่ามีอะไรให้ช่วย ห้ามขอรหัสผ่าน OTP หรือข้อมูลการเงินส่วนตัว ห้ามทำธุรกรรม
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
			"audio": map[string]any{
				"input":  map[string]any{"transcription": map[string]string{"model": "gpt-transcribe", "language": "th"}},
				"output": map[string]string{"voice": input.Voice},
			},
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
		if !validVoiceCallID(id) {
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
		w.Header().Set("X-Phone-History", strconv.FormatBool(attachPhoneHistory(id)))
		w.Header().Set("X-Voice-Call-ID", id)
		w.Header().Set("X-Voice-Recording-Token", recordingToken(id))
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

func validVoiceCallID(id string) bool {
	if !strings.HasPrefix(id, "rtc_") || len(id) < 5 || len(id) > 100 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func registerVoiceRecordings(routes *http.ServeMux, authorized func(*http.Request) bool, token func(string) string) {
	const dir = "/var/lib/wirachit"
	routes.HandleFunc("/api/v1/voice/recordings/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		w.Header().Set("Cache-Control", "no-store")
		if !authorized(r) || !validVoiceCallID(id) ||
			!hmac.Equal([]byte(r.Header.Get("X-Voice-Recording-Token")), []byte(token(id))) {
			http.Error(w, "Invalid recording access", http.StatusUnauthorized)
			return
		}
		filename := filepath.Join(dir, id+".webm")
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "audio/webm")
			w.Header().Set("Content-Disposition", "attachment; filename="+id+".webm")
			http.ServeFile(w, r, filename)
		case http.MethodPut:
			if r.Header.Get("Content-Type") != "audio/webm" {
				http.Error(w, "Expected audio/webm", http.StatusUnsupportedMediaType)
				return
			}
			body := http.MaxBytesReader(w, r.Body, 5<<20)
			header := make([]byte, 4)
			if _, err := io.ReadFull(body, header); err != nil || !bytes.Equal(header, []byte{0x1a, 0x45, 0xdf, 0xa3}) {
				http.Error(w, "Invalid WebM recording", http.StatusBadRequest)
				return
			}
			file, err := os.CreateTemp(dir, "recording-*")
			if err != nil {
				http.Error(w, "Recording storage unavailable", http.StatusServiceUnavailable)
				return
			}
			defer os.Remove(file.Name())
			defer file.Close()
			if _, err := io.Copy(file, io.MultiReader(bytes.NewReader(header), body)); err != nil {
				http.Error(w, "Could not receive recording", http.StatusBadRequest)
				return
			}
			if err := file.Sync(); err != nil {
				http.Error(w, "Could not save recording", http.StatusInternalServerError)
				return
			}
			if err := os.Link(file.Name(), filename); err != nil {
				if os.IsExist(err) {
					http.Error(w, "Recording already saved", http.StatusConflict)
				} else {
					http.Error(w, "Could not save recording", http.StatusInternalServerError)
				}
				return
			}
			w.WriteHeader(http.StatusCreated)
		default:
			w.Header().Set("Allow", "GET, PUT")
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
}
