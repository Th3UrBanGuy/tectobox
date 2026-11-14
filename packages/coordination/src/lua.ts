/**
 * Named Redis Lua scripts — @tectonic/coordination (Phase 6 of the modular
 * restructure). The inline Lua in RedisCoordinator is moved here verbatim
 * so each script has one name and one definition. Two methods shared one
 * byte-identical script (releaseLease / releaseLock); they now share the
 * single COMPARE_AND_DELETE_SCRIPT constant. No script text is changed.
 */

export const RATE_LIMIT_SCRIPT = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local windowStart = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local windowSec = tonumber(ARGV[4])
      local member = ARGV[5]

      redis.call("zremrangebyscore", key, 0, windowStart)
      local currentCount = redis.call("zcard", key)
      if currentCount < limit then
        redis.call("zadd", key, now, member)
        redis.call("expire", key, windowSec)
        return 1
      else
        return 0
      end
    `;

export const LEASE_SET_NX_SCRIPT = `
      if redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2], "NX") then
        return 1
      else
        return 0
      end
    `;

export const LEASE_TOUCH_SCRIPT = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("expire", KEYS[1], ARGV[2])
        return 1
      else
        return 0
      end
    `;

export const LEASE_RENEW_SCRIPT = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

export const COMPARE_AND_DELETE_SCRIPT = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

export const CLAIM_SEND_ATTEMPT_SCRIPT = `
      local current = redis.call("get", KEYS[1])
      if current == "sent" or current == "sending" or current == "outcome-unknown" then
        return {0, current}
      end
      redis.call("set", KEYS[1], "sending", "EX", ARGV[1])
      return {1, "sending"}
    `;
