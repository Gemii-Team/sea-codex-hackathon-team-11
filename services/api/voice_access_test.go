package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicDemoAccess(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("VOICE_DEMO_CODE", "test-code")
	t.Setenv("PHONE_HISTORY_URL", "")
	routes := http.NewServeMux()
	registerVoice(routes)
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"POST", "/api/v1/voice/calls", 415},
		{"POST", "/api/v1/voice/calls/rtc_test/hangup", 403},
		{"GET", "/api/v1/voice/recordings/rtc_test", 401},
		{"PUT", "/api/v1/voice/recordings/rtc_test", 401},
		{"POST", "/api/v1/phone/finish/rtc_test", 403},
		{"GET", "/api/v1/phone/history", 401},
		{"GET", "/api/v1/phone/history/rtc_test", 401},
		{"GET", "/api/v1/phone/evidence/rtc_test", 401},
		{"GET", "/api/v1/phone/history/demo-otp-request", 503},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		routes.ServeHTTP(w, req)
		if w.Code != tc.want {
			t.Errorf("%s %s: got %d, want %d", tc.method, tc.path, w.Code, tc.want)
		}
	}
}
