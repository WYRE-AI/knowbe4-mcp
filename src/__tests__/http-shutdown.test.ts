/**
 * HTTP shutdown must not reject. close() errors (including a duplicate
 * signal's ERR_SERVER_NOT_RUNNING) are logged and exit 1.
 */

import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdownHttpServer } from "../index.js";

function serverWithClose(close: Server["close"]): Server {
  return { close } as Server;
}

describe("shutdownHttpServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 0 after a successful close", async () => {
    const exit = vi.fn();
    const close = vi.fn((callback?: (err?: Error) => void) => {
      callback?.();
      return serverWithClose(close);
    }) as Server["close"];

    await expect(shutdownHttpServer(serverWithClose(close), exit)).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("logs a close failure and exits 1 without rejecting", async () => {
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const close = vi.fn((callback?: (err?: Error) => void) => {
      callback?.(new Error("Server is not running."));
      return serverWithClose(close);
    }) as Server["close"];

    await expect(shutdownHttpServer(serverWithClose(close), exit)).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("HTTP server close failed");
    expect(logged).toContain("Server is not running.");
  });
});
