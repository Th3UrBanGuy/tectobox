package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Port                   string
	RabbitMQURL            string
	RabbitMQStartupTimeout time.Duration
	RabbitMQReconnectMax   time.Duration
	MetaAppSecret          string
	MetaVerifyToken        string
	TelegramWebhookSecret  string
	TelegramBotTenantMap   string // JSON string e.g. {"bot_token_or_secret": 1, "secret_xyz": 2}
	MetaPageMappings       string // JSON string e.g. {"123456": 1, "page_abc": 2}
	RedisURL               string
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

	startupTimeout := 60 * time.Second
	if val := os.Getenv("RABBITMQ_STARTUP_TIMEOUT_MS"); val != "" {
		if ms, err := strconv.Atoi(val); err == nil && ms > 0 {
			startupTimeout = time.Duration(ms) * time.Millisecond
		}
	}

	reconnectMax := 30 * time.Second
	if val := os.Getenv("RABBITMQ_RECONNECT_MAX_MS"); val != "" {
		if ms, err := strconv.Atoi(val); err == nil && ms > 0 {
			reconnectMax = time.Duration(ms) * time.Millisecond
		}
	}

	return &Config{
		Port:                   port,
		RabbitMQURL:            rabbitMQURL,
		RabbitMQStartupTimeout: startupTimeout,
		RabbitMQReconnectMax:   reconnectMax,
		MetaAppSecret:          os.Getenv("META_APP_SECRET"),
		MetaVerifyToken:        os.Getenv("META_VERIFY_TOKEN"),
		TelegramWebhookSecret:  os.Getenv("TELEGRAM_WEBHOOK_SECRET"),
		TelegramBotTenantMap:   os.Getenv("TELEGRAM_BOT_TENANT_MAP"),
		MetaPageMappings:       os.Getenv("META_PAGE_MAPPINGS"),
		RedisURL:               os.Getenv("REDIS_URL"),
	}
}
