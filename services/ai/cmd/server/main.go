package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tect0nicofficial/tectobox/services/ai/pkg/server"
)

func main() {
	port := flag.Int("port", 8081, "Port to listen on")
	flag.Parse()

	if envPort := os.Getenv("PORT"); envPort != "" {
		fmt.Sscanf(envPort, "%d", port)
	}

	srv := server.NewServer()
	httpServer := &http.Server{
		Addr:         fmt.Sprintf("0.0.0.0:%d", *port),
		Handler:      srv.Routes(),
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Printf("[tectobox-ai-go] High-performance AI Engine listening on http://0.0.0.0:%d\n", *port)
		log.Printf("[tectobox-ai-go] Endpoints: /v1/chat/completions (OpenAI), /api/ai/chat (Internal), /health\n")
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[tectobox-ai-go] HTTP server error: %v", err)
		}
	}()

	// Wait for terminate signal
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("[tectobox-ai-go] Shutting down gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("[tectobox-ai-go] Shutdown error: %v", err)
	}
	log.Println("[tectobox-ai-go] Server stopped.")
}
