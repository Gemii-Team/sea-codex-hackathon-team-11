package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
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

var errVoiceLimit = errors.New("demo call limit reached")

type voiceReservation struct {
	id    string
	until time.Time
	end   func() bool
}

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
	callOwner := func(r *http.Request, id string) bool {
		return code != "" && validVoiceCallID(id) && hmac.Equal([]byte(r.Header.Get("X-Voice-Recording-Token")), []byte(recordingToken(id)))
	}
	attachPhoneHistory := registerPhoneHistory(routes, authorized, callOwner)
	registerVoiceSamples(routes, key)
	registerVoiceRecordings(routes, callOwner)
	var lock sync.Mutex
	var active *voiceReservation
	routes.HandleFunc("GET /api/v1/voice/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		lock.Lock()
		defer lock.Unlock()
		count, err := voiceCallCount()
		if err != nil || key == "" || code == "" {
			http.Error(w, "Voice demo unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"busy": active != nil, "remaining": max(0, demoCallLimit-count)})
	})
	routes.HandleFunc("POST /api/v1/voice/calls/{id}/hangup", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !callOwner(r, id) {
			http.Error(w, "Invalid call access", http.StatusForbidden)
			return
		}
		lock.Lock()
		current := active
		if current == nil || current.id != id {
			lock.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		end := current.end
		lock.Unlock()
		if !end() {
			http.Error(w, "Hangup pending", http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	routes.HandleFunc("POST /api/v1/voice/calls", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if key == "" || code == "" {
			http.Error(w, "Voice demo is unavailable", http.StatusServiceUnavailable)
			return
		}
		if typ, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || typ != "application/json" {
			http.Error(w, "Expected JSON", http.StatusUnsupportedMediaType)
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
		instructions := fmt.Sprintf(`คุณคือคนรับโทรศัพท์ในสายฝึกรับมือมิจฉาชีพภาษาไทย เล่นตามบุคลิกที่ตั้งไว้จนจบสาย
คุยเหมือนรับสายที่บ้าน ตอบสิ่งที่เพิ่งได้ยินก่อนเสมอ พูดครั้งละหนึ่งหรือสองประโยคสั้น ๆ เว้นจังหวะให้คนโทรพูด บางตาแค่รับคำก็พอ ใช้คำเรียกญาติและคำลงท้ายพอดี ไม่ต้องเรียก “ลูก” ทุกประโยค
ให้ความสนใจสิ่งที่ผู้โทรเสนอ หากยังไม่เข้าใจให้ถามเพียงเรื่องเดียวจากที่เขาเพิ่งพูด จำสิ่งที่เขาบอกแล้ว อย่ายิงคำถามตามรายการ เป้าหมายการฝึกและคำถามในโปรไฟล์ใช้เมื่อเข้ากับเรื่องเท่านั้น
ถ้าเขาขอพร้อมเพย์ของยาย ให้ฟังว่าเขาจะโอนให้หรือให้ยายโอน ถ้ายังไม่ชัด ลองถาม “หนูจะโอนอะไรให้ยายเหรอจ๊ะ” ถ้าเขาบอกเหตุผลแล้วให้รับรู้เหตุผลนั้นโดยไม่ถามซ้ำ
ยายมีรายละเอียดสมมติให้คุยต่อได้จริงในฉากนี้: พร้อมเพย์ผูกเบอร์มือถือ ยายจำได้แค่ท้าย 2742 เมื่อต้องบอกให้พูดทีละหลัก “สอง เจ็ด สี่ สอง” ตามจังหวะสนทนา ถ้าเขาขอเลขเต็ม ให้บอกตามบทว่ายายจำได้แค่นี้ แล้วฟังหรือถามเรื่องที่ยังสงสัย อย่าแต่งหลักที่เหลือ
ตัวอย่างเมื่อผู้โทรบอกว่าจะคืนค่าพัสดุ: “อ๋อ ค่าส่งคราวก่อนเหรอจ๊ะ ของยายผูกกับเบอร์มือถือ ลงท้ายสอง เจ็ด สี่ สอง” ปรับคำตามเรื่องจริงในสาย ห้ามท่องตัวอย่างเมื่อไม่ตรงเรื่อง
ถ้าผู้โทรอยากให้ยายจ่าย ให้ถามว่าเป็นค่าอะไรถ้ายังไม่ทราบ ห้ามโอนเงินจริง อ้างว่าทำรายการสำเร็จ หรือให้เลขใช้งานจริง รหัสผ่าน PIN หรือ OTP อยู่ในบทโดยใช้เหตุผลของตัวละคร ไม่เทศนาหรือกล่าวหาผู้โทร
ชื่อ: %s
บุคลิก: %s
น้ำเสียง: %s
เป้าหมาย: %s
คำทักทาย: %s
คำถามสำรอง ใช้เฉพาะตอนที่ผู้โทรยังไม่ได้บอกธุระ: %s
คำสั่งเพิ่มเติม: %s

ลำดับการตอบ: ถ้าผู้โทรบอกว่าจะโอนคืนและขอพร้อมเพย์ของยาย ให้ตอบคำขอนั้นในตานี้ทันที บอกว่าผูกมือถือและบอกสี่ตัวท้ายสมมติ 2742 ออกเสียงทีละหลัก พูดจบแล้วหยุดให้เขาตอบ ข้ามคำถามสำรองและพักเป้าหมายเก็บข้อมูลไว้ก่อน ถ้าเขาขอพร้อมเพย์โดยยังไม่ได้บอกเหตุผล ให้ถามเหตุผลเพียงครั้งเดียว`, input.Name, input.Persona, input.Tone, input.Objective, input.Greeting, input.Question, input.Instructions)
		session, err := json.Marshal(map[string]any{
			"type": "realtime", "model": "gpt-realtime-2.1-mini",
			"instructions": instructions, "max_output_tokens": 400,
			"audio": map[string]any{
				"input": map[string]any{
					"transcription": map[string]string{"model": "gpt-transcribe", "language": "th"},
					"turn_detection": map[string]any{"type": "server_vad", "silence_duration_ms": 650,
						"prefix_padding_ms": 300, "interrupt_response": true, "create_response": true},
				},
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
		if active != nil {
			seconds := max(1, int(time.Until(active.until).Seconds())+1)
			w.Header().Set("Retry-After", strconv.Itoa(seconds))
			lock.Unlock()
			http.Error(w, "A demo call is already reserved", http.StatusConflict)
			return
		}
		reservation := &voiceReservation{until: time.Now().Add(callDuration)}
		count, err := voiceCallCount()
		if err == nil {
			if count >= demoCallLimit {
				err = errVoiceLimit
			} else {
				err = writeVoiceCallCount(count + 1)
			}
		}
		if err == nil {
			active = reservation
		}
		lock.Unlock()
		if err != nil {
			log.Printf("voice quota: %v", err)
			if errors.Is(err, errVoiceLimit) {
				http.Error(w, "Voice demo quota exhausted", http.StatusTooManyRequests)
			} else {
				http.Error(w, "Voice quota storage unavailable", http.StatusServiceUnavailable)
			}
			return
		}
		release := func() {
			lock.Lock()
			if active == reservation {
				active = nil
			}
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
			lock.Lock()
			if err := writeVoiceCallCount(count); err != nil {
				log.Print("Could not restore quota after rejected call")
			}
			active = nil
			lock.Unlock()
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
		var ending sync.Mutex
		ended := false
		end := func() bool {
			ending.Lock()
			defer ending.Unlock()
			if ended {
				return true
			}
			req, _ := http.NewRequest(http.MethodPost,
				"https://api.openai.com/v1/realtime/calls/"+id+"/hangup", nil)
			req.Header.Set("Authorization", "Bearer "+key)
			resp, err := client.Do(req)
			if err != nil {
				return false
			}
			defer resp.Body.Close()
			if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound {
				return false
			}
			ended = true
			release()
			return true
		}
		lock.Lock()
		reservation.id, reservation.end, reservation.until = id, end, time.Now().Add(callDuration)
		lock.Unlock()
		time.AfterFunc(callDuration, func() {
			for attempt := 0; attempt < 3; attempt++ {
				if end() {
					return
				}
				time.Sleep(time.Second)
			}
			log.Print("OpenAI call cleanup did not confirm hangup")
			release()
		})
		w.Header().Set("Content-Type", "application/sdp")
		w.Header().Set("X-Phone-History", strconv.FormatBool(attachPhoneHistory(id)))
		w.Header().Set("X-Voice-Call-ID", id)
		w.Header().Set("X-Voice-Recording-Token", recordingToken(id))
		_, _ = io.Copy(w, io.LimitReader(response.Body, 32<<10))
	})
}

// This stack runs one API replica. Persist reservations on its durable volume.
const voiceCountFile = "/var/lib/wirachit/voice-call-count"

func voiceCallCount() (int, error) {
	value, err := os.ReadFile(voiceCountFile)
	count := 0
	if err == nil {
		count, err = strconv.Atoi(string(value))
		if err != nil || count < 0 {
			return 0, fmt.Errorf("invalid voice call count")
		}
	} else if !os.IsNotExist(err) {
		return 0, err
	}
	return count, nil
}

func writeVoiceCallCount(count int) error {
	if err := os.WriteFile(voiceCountFile+".next", []byte(strconv.Itoa(count)), 0600); err != nil {
		return err
	}
	return os.Rename(voiceCountFile+".next", voiceCountFile)
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

func registerVoiceRecordings(routes *http.ServeMux, callOwner func(*http.Request, string) bool) {
	const dir = "/var/lib/wirachit"
	routes.HandleFunc("/api/v1/voice/recordings/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		w.Header().Set("Cache-Control", "no-store")
		if !callOwner(r, id) {
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
