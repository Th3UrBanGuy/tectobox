// Test-only JWT secret so modules that load app config at import time
// (loadAppConfig() throws without JWT_SECRET) can be imported in tests.
// Production code has no fallback — this value exists only in tests.
process.env.JWT_SECRET ??= 'vitest-only-test-secret-not-for-production-use';
