const memoryCache = new Map();

function redisConfigured() {
  return Boolean(process.env.REDIS_REST_URL && process.env.REDIS_REST_TOKEN);
}

function cacheEnabled() {
  return process.env.CACHE_DISABLED !== "true";
}

function now() {
  return Date.now();
}

function pruneMemoryCache() {
  const current = now();
  for (const [key, entry] of memoryCache.entries()) {
    if (entry.expiresAt <= current) {
      memoryCache.delete(key);
    }
  }
}

async function redisCommand(command) {
  const response = await fetch(process.env.REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  if (!response.ok) {
    throw new Error(`Redis HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.result;
}

async function getJson(key) {
  if (!cacheEnabled()) {
    return null;
  }

  if (redisConfigured()) {
    try {
      const value = await redisCommand(["GET", key]);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  }

  pruneMemoryCache();
  const entry = memoryCache.get(key);
  return entry && entry.expiresAt > now() ? entry.value : null;
}

async function setJson(key, value, ttlSeconds = 30) {
  if (!cacheEnabled()) {
    return false;
  }

  const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 30));
  if (redisConfigured()) {
    try {
      await redisCommand(["SET", key, JSON.stringify(value), "EX", String(ttl)]);
      return true;
    } catch (error) {
      return false;
    }
  }

  memoryCache.set(key, {
    value,
    expiresAt: now() + ttl * 1000
  });
  return true;
}

async function del(key) {
  if (redisConfigured()) {
    try {
      await redisCommand(["DEL", key]);
    } catch (error) {
      // Cache invalidation should never break the request path.
    }
  }
  memoryCache.delete(key);
}

function status() {
  return {
    enabled: cacheEnabled(),
    provider: redisConfigured() ? "redis-rest" : "memory",
    memoryKeys: memoryCache.size
  };
}

module.exports = {
  del,
  getJson,
  setJson,
  status
};
