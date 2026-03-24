import IORedis from "ioredis";

declare global {
  var redisGlobal: IORedis | undefined;
}

function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times: number) {
      if (times > 3) {
        console.warn("Redis connection failed after 3 retries. Queues will not work.");
        return null; // stop retrying
      }
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  connection.connect().catch((err) => {
    console.warn("Redis not available:", err.message);
    console.warn("Background sync jobs (queues) will not work. App UI will still function.");
  });

  return connection;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.redisGlobal) {
    global.redisGlobal = createRedisConnection();
  }
}

const redis = global.redisGlobal ?? createRedisConnection();

export default redis;
