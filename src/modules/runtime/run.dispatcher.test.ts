import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dispatcher tests.
 *
 * The dispatcher decides *where* a run executes. Redis is not available in every
 * environment (and never in unit tests), so the transport is exercised here with
 * the queue and Redis probes mocked: the real BullMQ/worker path is covered by
 * `scripts/verify-phase2.ts` against the database.
 */

const mocks = vi.hoisted(() => ({
  mode: "inline" as string,
  pingRedis: vi.fn(),
  enqueueRun: vi.fn(),
  executeRun: vi.fn(),
}));

vi.mock("@/config/env", () => ({
  getEnv: () => ({ RUN_EXECUTION_MODE: mocks.mode }),
}));

vi.mock("@/lib/redis/connection", () => ({
  pingRedis: mocks.pingRedis,
}));

vi.mock("./queues", () => ({
  enqueueRun: mocks.enqueueRun,
}));

vi.mock("./run.executor", () => ({
  executeRun: mocks.executeRun,
}));

const { dispatchRun } = await import("./run.dispatcher");

const RUN_ID = "run-1";
const VERSION_ID = "version-1";

beforeEach(() => {
  mocks.mode = "inline";
  mocks.pingRedis.mockReset();
  mocks.enqueueRun.mockReset();
  mocks.executeRun.mockReset();
  mocks.executeRun.mockResolvedValue({ runId: RUN_ID, status: "SUCCEEDED", skipped: false });
});

describe("dispatchRun", () => {
  it("executes in-process when RUN_EXECUTION_MODE=inline", async () => {
    const result = await dispatchRun(RUN_ID, VERSION_ID);

    expect(result).toEqual({ mode: "inline", jobId: null });
    await vi.waitFor(() => {
      expect(mocks.executeRun).toHaveBeenCalledWith(RUN_ID, { transport: "inline" });
    });
    expect(mocks.enqueueRun).not.toHaveBeenCalled();
  });

  it("enqueues the job when RUN_EXECUTION_MODE=queue", async () => {
    mocks.mode = "queue";
    mocks.enqueueRun.mockResolvedValue(RUN_ID);

    const result = await dispatchRun(RUN_ID, VERSION_ID);

    expect(result).toEqual({ mode: "queue", jobId: RUN_ID });
    expect(mocks.enqueueRun).toHaveBeenCalledWith({
      runId: RUN_ID,
      harnessVersionId: VERSION_ID,
    });
    expect(mocks.executeRun).not.toHaveBeenCalled();
    // A queued run must never also run in this process.
    expect(mocks.pingRedis).not.toHaveBeenCalled();
  });

  it("uses the queue in auto mode when Redis answers", async () => {
    mocks.mode = "auto";
    mocks.pingRedis.mockResolvedValue("PONG");
    mocks.enqueueRun.mockResolvedValue(RUN_ID);

    const result = await dispatchRun(RUN_ID, VERSION_ID);

    expect(result.mode).toBe("queue");
    expect(mocks.executeRun).not.toHaveBeenCalled();
  });

  it("falls back to inline execution when Redis is unreachable", async () => {
    mocks.mode = "auto";
    mocks.pingRedis.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await dispatchRun(RUN_ID, VERSION_ID);

    expect(result).toEqual({ mode: "inline", jobId: null });
    await vi.waitFor(() => {
      expect(mocks.executeRun).toHaveBeenCalledTimes(1);
    });
    expect(mocks.enqueueRun).not.toHaveBeenCalled();
  });

  it("falls back to inline execution when enqueueing fails", async () => {
    mocks.mode = "auto";
    mocks.pingRedis.mockResolvedValue("PONG");
    mocks.enqueueRun.mockRejectedValue(new Error("queue unavailable"));

    const result = await dispatchRun(RUN_ID, VERSION_ID);

    expect(result).toEqual({ mode: "inline", jobId: null });
    await vi.waitFor(() => {
      expect(mocks.executeRun).toHaveBeenCalledWith(RUN_ID, { transport: "inline" });
    });
  });

  it("records the queue transport on queued runs", async () => {
    mocks.mode = "queue";
    mocks.enqueueRun.mockResolvedValue(RUN_ID);

    await dispatchRun(RUN_ID, VERSION_ID);

    // The job payload is what the worker validates; it must always carry both ids.
    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, harnessVersionId: VERSION_ID }),
    );
  });

  it("never rejects when inline execution fails", async () => {
    mocks.mode = "inline";
    mocks.executeRun.mockRejectedValue(new Error("provider exploded"));

    await expect(dispatchRun(RUN_ID, VERSION_ID)).resolves.toEqual({
      mode: "inline",
      jobId: null,
    });
  });
});
