package config

import (
	"os"
	"testing"
)

func TestConfigLoad_Defaults(t *testing.T) {
	os.Unsetenv("PORT")
	os.Unsetenv("RABBITMQ_URL")
	os.Unsetenv("META_APP_SECRET")
	os.Unsetenv("META_VERIFY_TOKEN")
	os.Unsetenv("TELEGRAM_WEBHOOK_SECRET")
	os.Unsetenv("TELEGRAM_BOT_TENANT_MAP")
	os.Unsetenv("META_PAGE_MAPPINGS")
	os.Unsetenv("REDIS_URL")

	cfg := Load()

	if cfg.Port != "8080" {
		t.Fatalf("expected default port 8080, got %s", cfg.Port)
	}
	if cfg.RabbitMQURL != "amqp://guest:guest@localhost:5672/" {
		t.Fatalf("expected default rabbitmq url, got %s", cfg.RabbitMQURL)
	}
	if cfg.MetaVerifyToken != "" {
		t.Fatalf("expected empty meta verify token, got %s", cfg.MetaVerifyToken)
	}
	if cfg.TelegramBotTenantMap != "" {
		t.Fatalf("expected empty telegram bot tenant map, got %s", cfg.TelegramBotTenantMap)
	}
	if cfg.MetaPageMappings != "" {
		t.Fatalf("expected empty meta page mappings, got %s", cfg.MetaPageMappings)
	}
}

func TestConfigLoad_FromEnv(t *testing.T) {
	os.Setenv("PORT", "9090")
	os.Setenv("RABBITMQ_URL", "amqp://user:pass@mq:5672/")
	os.Setenv("META_APP_SECRET", "app_secret")
	os.Setenv("META_VERIFY_TOKEN", "verify_token")
	os.Setenv("TELEGRAM_WEBHOOK_SECRET", "tg_secret")
	os.Setenv("TELEGRAM_BOT_TENANT_MAP", `{"secret_123":1}`)
	os.Setenv("META_PAGE_MAPPINGS", `{"123":1}`)
	defer func() {
		os.Unsetenv("PORT")
		os.Unsetenv("RABBITMQ_URL")
		os.Unsetenv("META_APP_SECRET")
		os.Unsetenv("META_VERIFY_TOKEN")
		os.Unsetenv("TELEGRAM_WEBHOOK_SECRET")
		os.Unsetenv("TELEGRAM_BOT_TENANT_MAP")
		os.Unsetenv("META_PAGE_MAPPINGS")
	}()

	cfg := Load()

	if cfg.Port != "9090" {
		t.Fatalf("expected port 9090, got %s", cfg.Port)
	}
	if cfg.RabbitMQURL != "amqp://user:pass@mq:5672/" {
		t.Fatalf("expected custom rabbitmq url, got %s", cfg.RabbitMQURL)
	}
	if cfg.MetaAppSecret != "app_secret" {
		t.Fatalf("expected app_secret, got %s", cfg.MetaAppSecret)
	}
	if cfg.MetaVerifyToken != "verify_token" {
		t.Fatalf("expected verify_token, got %s", cfg.MetaVerifyToken)
	}
	if cfg.TelegramWebhookSecret != "tg_secret" {
		t.Fatalf("expected tg_secret, got %s", cfg.TelegramWebhookSecret)
	}
	if cfg.TelegramBotTenantMap != `{"secret_123":1}` {
		t.Fatalf("expected `{\"secret_123\":1}`, got %s", cfg.TelegramBotTenantMap)
	}
	if cfg.MetaPageMappings != `{"123":1}` {
		t.Fatalf("expected `{\"123\":1}`, got %s", cfg.MetaPageMappings)
	}
}
