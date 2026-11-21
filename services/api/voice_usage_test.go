package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadVoiceSeconds(t *testing.T) {
	dir := t.TempDir()
	check := func(want int) {
		t.Helper()
		used, err := readVoiceSeconds(dir)
		if err != nil || used != want {
			t.Fatalf("got %d, %v; want %d seconds", used, err, want)
		}
	}
	write := func(name, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	check(0)
	write("voice-call-count", "19")
	check(19 * 180)
	write("voice-seconds-used", "3431")
	check(3431)
	write("voice-seconds-used", "invalid")
	if _, err := readVoiceSeconds(dir); err == nil {
		t.Fatal("invalid ledger must not reset budget")
	}
}
