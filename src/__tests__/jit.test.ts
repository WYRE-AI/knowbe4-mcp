/**
 * Tests for JIT tenant token minting, caching, and tenant queries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getJitToken, tenantQuery, clearJitTokenCache, JIT_TOKEN_TTL_MS } from "../utils/jit.js";
import { PARTNER_NOT_CONFIGURED_MESSAGE, TENANT_GRAPHQL_NOT_CONFIGURED_MESSAGE } from "../utils/graphql.js";

const originalEnv = process.env;
let fetchMock: ReturnType<typeof vi.fn>;

const JWT = "eyJhbGciOiJIUzI1NiJ9.SECRET-JIT-JWT.sig";

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Error",
  text: async () => JSON.stringify(body),
});

const jitOk = (token = JWT) => jsonResponse({ data: { apiTokensGenerateJit: { node: token, errors: [] } } });

/** Parsed body of the n-th fetch call. */
const requestBody = (n: number) => JSON.parse((fetchMock.mock.calls[n][1] as RequestInit).body as string);
const requestAuth = (n: number) =>
  ((fetchMock.mock.calls[n][1] as RequestInit).headers as Record<string, string>).Authorization;

beforeEach(() => {
  process.env = { ...originalEnv, KNOWBE4_PARTNER_API_KEY: "partner-key" };
  delete process.env.KNOWBE4_REGION;
  delete process.env.KNOWBE4_GRAPHQL_URL;
  clearJitTokenCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

describe("getJitToken", () => {
  it("mints a token with the partner key and the account id", async () => {
    fetchMock.mockResolvedValueOnce(jitOk());

    const token = await getJitToken(42);

    expect(token).toBe(JWT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://training.knowbe4.com/graphql");
    expect(requestAuth(0)).toBe("Bearer partner-key");
    const body = requestBody(0);
    expect(body.query).toContain("apiTokensGenerateJit(accountId: $accountId)");
    expect(body.variables).toEqual({ accountId: 42 });
  });

  it("reuses the cached token for the same account", async () => {
    fetchMock.mockResolvedValueOnce(jitOk());

    await getJitToken(42);
    await getJitToken(42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mints separately per account", async () => {
    fetchMock.mockResolvedValueOnce(jitOk("jwt-a")).mockResolvedValueOnce(jitOk("jwt-b"));

    expect(await getJitToken(1)).toBe("jwt-a");
    expect(await getJitToken(2)).toBe("jwt-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("mints separately per partner key so gateway partners never share tokens", async () => {
    fetchMock.mockResolvedValueOnce(jitOk("jwt-partner-1")).mockResolvedValueOnce(jitOk("jwt-partner-2"));

    expect(await getJitToken(1)).toBe("jwt-partner-1");
    process.env.KNOWBE4_PARTNER_API_KEY = "other-partner-key";
    expect(await getJitToken(1)).toBe("jwt-partner-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-mints once the cached token is past its TTL", async () => {
    fetchMock.mockResolvedValueOnce(jitOk("jwt-old")).mockResolvedValueOnce(jitOk("jwt-new"));
    let clock = 1_000_000;
    const now = () => clock;

    expect(await getJitToken(42, now)).toBe("jwt-old");
    clock += JIT_TOKEN_TTL_MS - 1;
    expect(await getJitToken(42, now)).toBe("jwt-old");
    clock += 2;
    expect(await getJitToken(42, now)).toBe("jwt-new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight mint between concurrent callers", async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const first = getJitToken(42);
    const second = getJitToken(42);
    release(jitOk());

    expect(await first).toBe(JWT);
    expect(await second).toBe(JWT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces mutation errors and does not cache the failure", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: { apiTokensGenerateJit: { node: null, errors: [{ field: "accountId", reason: "not managed by partner" }] } },
        })
      )
      .mockResolvedValueOnce(jitOk());

    await expect(getJitToken(99)).rejects.toThrow(
      "Could not generate a JIT token for account 99: accountId: not managed by partner"
    );
    expect(await getJitToken(99)).toBe(JWT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the configuration hint without a partner key", async () => {
    delete process.env.KNOWBE4_PARTNER_API_KEY;
    await expect(getJitToken(1)).rejects.toThrow(PARTNER_NOT_CONFIGURED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never writes the JWT to the log", async () => {
    process.env.LOG_LEVEL = "debug";
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jitOk());

    await getJitToken(42);

    const logged = stderr.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain(JWT);
    expect(logged).not.toContain("SECRET-JIT-JWT");
  });
});

describe("tenantQuery", () => {
  it("mints a JIT token then runs the query with it", async () => {
    fetchMock
      .mockResolvedValueOnce(jitOk())
      .mockResolvedValueOnce(jsonResponse({ data: { users: { nodes: [{ id: 1 }] } } }));

    const data = await tenantQuery<{ users: { nodes: unknown[] } }>(42, "query U { users { nodes { id } } }", {
      per: 25,
    });

    expect(data.users.nodes).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestAuth(1)).toBe(`Bearer ${JWT}`);
    expect(requestBody(1)).toEqual({ query: "query U { users { nodes { id } } }", variables: { per: 25 } });
  });

  it("evicts the cached token after an authentication failure", async () => {
    fetchMock
      .mockResolvedValueOnce(jitOk("jwt-stale"))
      .mockResolvedValueOnce(jsonResponse({ message: "expired" }, 401))
      .mockResolvedValueOnce(jitOk("jwt-fresh"))
      .mockResolvedValueOnce(jsonResponse({ data: { account: { id: 42 } } }));

    await expect(tenantQuery(42, "query A { account { id } }")).rejects.toThrow("Authentication failed");
    await tenantQuery(42, "query A { account { id } }");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestAuth(3)).toBe("Bearer jwt-fresh");
  });

  it("with accountId null, calls GraphQL directly with the Product API key -- no JIT mint", async () => {
    process.env.KNOWBE4_PRODUCT_API_KEY = "product-key";
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { users: { nodes: [{ id: 1 }] } } }));

    const data = await tenantQuery<{ users: { nodes: unknown[] } }>(null, "query U { users { nodes { id } } }", {
      per: 25,
    });

    expect(data.users.nodes).toHaveLength(1);
    // Exactly one call -- a JIT mint would make this two, like the accountId=42 case above.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestAuth(0)).toBe("Bearer product-key");
    expect(requestBody(0)).toEqual({ query: "query U { users { nodes { id } } }", variables: { per: 25 } });
  });

  it("with accountId null and no Product API key configured, throws without calling fetch", async () => {
    delete process.env.KNOWBE4_PRODUCT_API_KEY;

    await expect(tenantQuery(null, "query U { users { nodes { id } } }")).rejects.toThrow(
      TENANT_GRAPHQL_NOT_CONFIGURED_MESSAGE
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
