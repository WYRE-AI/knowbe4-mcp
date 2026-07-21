/**
 * Tests for the KnowBe4 client utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiRequest, getCredentials } from "../utils/client.js";

describe("getCredentials", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return null when KNOWBE4_API_KEY is not set", () => {
    delete process.env.KNOWBE4_API_KEY;
    const creds = getCredentials();
    expect(creds).toBeNull();
  });

  it("should return credentials when KNOWBE4_API_KEY is set", () => {
    process.env.KNOWBE4_API_KEY = "test-api-key-123";
    const creds = getCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.apiKey).toBe("test-api-key-123");
    expect(creds!.baseUrl).toBe("https://us.api.knowbe4.com");
  });

  it("should use US region by default", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    delete process.env.KNOWBE4_REGION;
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://us.api.knowbe4.com");
  });

  it("should use EU region when specified", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    process.env.KNOWBE4_REGION = "eu";
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://eu.api.knowbe4.com");
  });

  it("should use CA region when specified", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    process.env.KNOWBE4_REGION = "ca";
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://ca.api.knowbe4.com");
  });

  it("should use UK region when specified", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    process.env.KNOWBE4_REGION = "uk";
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://uk.api.knowbe4.com");
  });

  it("should use DE region when specified", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    process.env.KNOWBE4_REGION = "de";
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://de.api.knowbe4.com");
  });

  it("should fall back to US for unknown region", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    process.env.KNOWBE4_REGION = "unknown";
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://us.api.knowbe4.com");
  });

  it("should allow custom base URL override", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    process.env.KNOWBE4_BASE_URL = "https://custom.api.example.com";
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://custom.api.example.com");
  });

  it("should handle case-insensitive region", () => {
    process.env.KNOWBE4_API_KEY = "test-key";
    process.env.KNOWBE4_REGION = "EU";
    const creds = getCredentials();
    expect(creds!.baseUrl).toBe("https://eu.api.knowbe4.com");
  });
});

describe("apiRequest URL construction", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.KNOWBE4_API_KEY = "test-key";
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "{}",
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  /** The URL the stubbed fetch was handed on its most recent call. */
  const requestedUrl = () => fetchMock.mock.calls[0][0] as string;

  it("should append the path to a bare-origin base URL", async () => {
    process.env.KNOWBE4_BASE_URL = "https://us.api.knowbe4.com";
    await apiRequest("/api/v1/account");
    expect(requestedUrl()).toBe("https://us.api.knowbe4.com/api/v1/account");
  });

  it("should preserve a base URL path prefix with a trailing slash", async () => {
    process.env.KNOWBE4_BASE_URL = "https://proxy.corp.example/knowbe4/";
    await apiRequest("/api/v1/account");
    expect(requestedUrl()).toBe("https://proxy.corp.example/knowbe4/api/v1/account");
  });

  it("should preserve a base URL path prefix without a trailing slash", async () => {
    process.env.KNOWBE4_BASE_URL = "https://proxy.corp.example/knowbe4";
    await apiRequest("/api/v1/phishing/security_tests");
    expect(requestedUrl()).toBe(
      "https://proxy.corp.example/knowbe4/api/v1/phishing/security_tests"
    );
  });

  it("should collapse redundant slashes on either side of the join", async () => {
    process.env.KNOWBE4_BASE_URL = "https://proxy.corp.example/knowbe4//";
    await apiRequest("//api/v1/users");
    expect(requestedUrl()).toBe("https://proxy.corp.example/knowbe4/api/v1/users");
  });

  it("should append query params after the joined path", async () => {
    process.env.KNOWBE4_BASE_URL = "https://proxy.corp.example/knowbe4/";
    await apiRequest("/api/v1/users", { params: { page: 2, per_page: 50 } });
    expect(requestedUrl()).toBe(
      "https://proxy.corp.example/knowbe4/api/v1/users?page=2&per_page=50"
    );
  });
});
