import { describe, expect, it } from "vitest";
import { buildRedisOptions, parseRedisUrl } from "./connection";

describe("parseRedisUrl", () => {
  it("parses a plain Redis URL", () => {
    expect(parseRedisUrl("redis://localhost:6379")).toEqual({ host: "localhost", port: 6379 });
  });

  it("parses credentials, database index, and TLS", () => {
    expect(parseRedisUrl("rediss://user:pass@redis.internal:6380/2")).toEqual({
      host: "redis.internal",
      port: 6380,
      username: "user",
      password: "pass",
      db: 2,
      tls: true,
    });
  });

  it("falls back to the default port", () => {
    expect(parseRedisUrl("redis://cache").port).toBe(6379);
  });
});

describe("buildRedisOptions", () => {
  it("fails fast instead of queueing commands while disconnected", () => {
    const options = buildRedisOptions("redis://localhost:6379");
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options.enableOfflineQueue).toBe(false);
    expect(typeof options.retryStrategy).toBe("function");
  });

  it("accepts overrides for worker connections", () => {
    const options = buildRedisOptions("redis://localhost:6379", { maxRetriesPerRequest: null });
    expect(options.maxRetriesPerRequest).toBeNull();
  });
});
