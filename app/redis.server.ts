import IORedis from "ioredis";

declare global {
  var redisGlobal: IORedis | undefined;
  var redisReady: boolean;
}

function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  global.redisReady = false;

  const connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times: number) {
      if (times > 3) {
        console.warn("Redis connection failed after 3 retries. Queues will not work.");
        global.redisReady = false;
        return null; // stop retrying
      }
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  // Track connection state
  connection.on("ready", () => {
    console.log("Redis connected and ready.");
    global.redisReady = true;
  });
  connection.on("close", () => {
    global.redisReady = false;
  });
  connection.on("end", () => {
    global.redisReady = false;
  });

  // Prevent unhandled 'error' events from crashing the process
  connection.on("error", (err) => {
    console.warn("Redis error:", err.message);
    global.redisReady = false;
  });

  connection.connect().catch((err) => {
    console.warn("Redis not available:", err.message);
    console.warn("Background sync jobs (queues) will not work. App UI will still function.");
    global.redisReady = false;
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

/** Check if Redis is connected and ready for operations */
export function isRedisAvailable(): boolean {
  return global.redisReady === true;
}
