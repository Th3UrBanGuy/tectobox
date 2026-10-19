package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/tect0nicofficial/tectobox/services/ingress/internal/config"
	"github.com/tect0nicofficial/tectobox/services/ingress/internal/handler"
	"github.com/tect0nicofficial/tectobox/services/ingress/internal/publisher"
	"github.com/tect0nicofficial/tectobox/services/ingress/internal/redis"
)

func main() {
	cfg := config.Load()

	pub, err := publisher.NewRabbitMQPublisher(cfg.RabbitMQURL)
	if err != nil {
		log.Fatalf("Failed to initialize publisher: %v", err)
	}
	defer pub.Close()

	var pageRoutes map[string]int
	if cfg.MetaPageMappings != "" {
		if err := json.Unmarshal([]byte(cfg.MetaPageMappings), &pageRoutes); err != nil {
			log.Printf("Warning: failed to parse META_PAGE_MAPPINGS JSON: %v", err)
		}
	}

	var tgBotTenantMap map[string]int
	if cfg.TelegramBotTenantMap != "" {
		if err := json.Unmarshal([]byte(cfg.TelegramBotTenantMap), &tgBotTenantMap); err != nil {
			log.Printf("Warning: failed to parse TELEGRAM_BOT_TENANT_MAP JSON: %v", err)
		}
	}

	redisClient := redis.NewClient(cfg.RedisURL)

	metaHandler := &handler.MetaHandler{
		AppSecret:        cfg.MetaAppSecret,
		VerifyToken:      cfg.MetaVerifyToken,
		Publisher:        pub,
		PageClientRoutes: pageRoutes,
	}

	telegramHandler := &handler.TelegramHandler{
		WebhookSecret: cfg.TelegramWebhookSecret,
		BotTenantMap:  tgBotTenantMap,
		Publisher:     pub,
	}

	if redisClient != nil {
		metaHandler.DynamicRoute = func(pageID string) int {
			cid, err := redisClient.GetInt("meta:page:" + pageID)
			if err == nil && cid > 0 {
				return cid
			}
			return 0
		}
		telegramHandler.DynamicRoute = func(token string) int {
			cid, err := redisClient.GetInt("telegram:bot:" + token)
			if err == nil && cid > 0 {
				return cid
			}
			return 0
		}
	}

	http.HandleFunc("/healthz", handler.HealthCheck)
	http.HandleFunc("/webhooks/meta", metaHandler.HandleWebhook)
	http.HandleFunc("/webhooks/telegram", telegramHandler.HandleWebhook)

	log.Printf("Starting ingress service on port %s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, nil); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
