import { z } from 'zod';

export const AppConfigSchema = z.object({
  port: z.number().int().default(3120),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  jwtSecret: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  databaseUrl: z.string().url().or(z.string().min(1)),
  redisUrl: z.string().url().or(z.string().min(1)),
  rabbitmqUrl: z.string().url().or(z.string().min(1)),
  goAiUrl: z.string().url().default('http://ai:8081/api/ai/chat'),
  geminiWeb2ApiUrl: z.string().url().default('http://ai:8081/v1'),
  maxPayloadBytes: z.number().int().default(50 * 1024 * 1024), // 50MB
  rateLimitWindowMs: z.number().int().default(60 * 1000), // 1 minute
  rateLimitMaxRequests: z.number().int().default(300), // 300 requests / minute
  authRateLimitMaxFailures: z.number().int().default(10), // 10 failed logins
  authBlockDurationMs: z.number().int().default(15 * 60 * 1000), // 15 mins
});

export type AppConfigType = z.infer<typeof AppConfigSchema>;

export function loadAppConfig(env: Record<string, string | undefined> = process.env): AppConfigType {
  const raw = {
    port: env.PORT ? Number(env.PORT) : 3120,
    nodeEnv: (env.NODE_ENV as any) || 'development',
    // C4: JWT secret comes from the environment only. The Zod schema
    // requires a string of min length 16, so a missing/empty JWT_SECRET
    // fails fast at startup instead of silently using a known fallback.
    jwtSecret: env.JWT_SECRET,
    databaseUrl: env.DATABASE_URL || 'postgres://tectobox:tectobox_dev@localhost:5432/tectobox',
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    rabbitmqUrl: env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    goAiUrl: env.GO_AI_URL || (env.NODE_ENV === 'production' ? 'http://ai:8081/api/ai/chat' : 'http://127.0.0.1:8081/api/ai/chat'),
    geminiWeb2ApiUrl: env.GEMINI_WEB2API_URL || (env.NODE_ENV === 'production' ? 'http://ai:8081/v1' : 'http://127.0.0.1:8081/v1'),
    maxPayloadBytes: env.MAX_PAYLOAD_BYTES ? Number(env.MAX_PAYLOAD_BYTES) : 50 * 1024 * 1024,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS ? Number(env.RATE_LIMIT_WINDOW_MS) : 60 * 1000,
    rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS ? Number(env.RATE_LIMIT_MAX_REQUESTS) : 300,
    authRateLimitMaxFailures: env.AUTH_MAX_FAILURES ? Number(env.AUTH_MAX_FAILURES) : 10,
    authBlockDurationMs: env.AUTH_BLOCK_DURATION_MS ? Number(env.AUTH_BLOCK_DURATION_MS) : 15 * 60 * 1000,
  };

  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `[Config Validation Failed] Application failed fast at boot due to missing or invalid environment variables:\n${errorDetails}`
    );
  }
  return parsed.data;
}

let _cachedConfig: AppConfigType | null = null;
export const getAppConfig = (): AppConfigType => {
  if (!_cachedConfig) {
    _cachedConfig = loadAppConfig();
  }
  return _cachedConfig;
};

export const AppConfig = new Proxy({} as AppConfigType, {
  get(_target, prop) {
    return (getAppConfig() as any)[prop];
  },
});
