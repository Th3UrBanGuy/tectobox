package handler

import (
	"net/http"
)

func init() {
	http.HandleFunc("/health", HealthCheck)
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}
