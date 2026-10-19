package config

import (
	"os"
)

type Config struct {
	Port                  string
	RabbitMQURL           string
	MetaAppSecret         string
	MetaVerifyToken       string
	TelegramWebhookSecret string
	TelegramBotTenantMap  string // JSON string e.g. {"bot_token_or_secret": 1, "secret_xyz": 2}
	MetaPageMappings      string // JSON string e.g. {"123456": 1, "page_abc": 2}
	RedisURL              string
}

func Load() *Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	rabbitMQURL := os.Getenv("RABBITMQ_URL")
	if rabbitMQURL == "" {
		rabbitMQURL = "amqp://guest:guest@localhost:5672/"
	}

	return &Config{
		Port:                  port,
		RabbitMQURL:           rabbitMQURL,
		MetaAppSecret:         os.Getenv("META_APP_SECRET"),
		MetaVerifyToken:       os.Getenv("META_VERIFY_TOKEN"),
		TelegramWebhookSecret: os.Getenv("TELEGRAM_WEBHOOK_SECRET"),
		TelegramBotTenantMap:  os.Getenv("TELEGRAM_BOT_TENANT_MAP"),
		MetaPageMappings:      os.Getenv("META_PAGE_MAPPINGS"),
		RedisURL:              os.Getenv("REDIS_URL"),
	}
}
