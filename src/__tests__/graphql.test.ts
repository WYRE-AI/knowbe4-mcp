/**
 * Tests for the KnowBe4 GraphQL client and partner credential resolution
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getPartnerCredentials,
  requirePartnerCredentials,
  getTenantGraphqlCredentials,
  requireTenantGraphqlCredentials,
  resolveGraphqlUrl,
  graphqlRequest,
  partnerQuery,
  PARTNER_NOT_CONFIGURED_MESSAGE,
  TENANT_GRAPHQL_NOT_CONFIGURED_MESSAGE,
} from "../utils/graphql.js";
import { credentialStore } from "../utils/client.js";

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.KNOWBE4_PARTNER_API_KEY;
  delete process.env.KNOWBE4_PRODUCT_API_KEY;
  delete process.env.KNOWBE4_REGION;
  delete process.env.KNOWBE4_GRAPHQL_URL;
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

describe("resolveGraphqlUrl", () => {
  it("defaults to the US endpoint", () => {
    expect(resolveGraphqlUrl()).toBe("https://training.knowbe4.com/graphql");
  });

  it("maps every region", () => {
    expect(resolveGraphqlUrl("eu")).toBe("https://eu.knowbe4.com/graphql");
    expect(resolveGraphqlUrl("CA")).toBe("https://ca.knowbe4.com/graphql");
    expect(resolveGraphqlUrl("uk")).toBe("https://uk.knowbe4.com/graphql");
    expect(resolveGraphqlUrl("de")).toBe("https://de.knowbe4.com/graphql");
  });

  it("falls back to US for an unknown region", () => {
    expect(resolveGraphqlUrl("mars")).toBe("https://training.knowbe4.com/graphql");
  });

  it("prefers an explicit override", () => {
    expect(resolveGraphqlUrl("eu", "https://proxy.example/graphql")).toBe("https://proxy.example/graphql");
  });
});

describe("getPartnerCredentials", () => {
  it("returns null when KNOWBE4_PARTNER_API_KEY is not set", () => {
    expect(getPartnerCredentials()).toBeNull();
  });

  it("reads the partner key and region from env", () => {
    process.env.KNOWBE4_PARTNER_API_KEY = "partner-key";
    process.env.KNOWBE4_REGION = "eu";
    expect(getPartnerCredentials()).toEqual({
      partnerApiKey: "partner-key",
      graphqlUrl: "https://eu.knowbe4.com/graphql",
    });
  });

  it("honors KNOWBE4_GRAPHQL_URL over the region", () => {
    process.env.KNOWBE4_PARTNER_API_KEY = "partner-key";
    process.env.KNOWBE4_REGION = "eu";
    process.env.KNOWBE4_GRAPHQL_URL = "https://proxy.example/graphql";
    expect(getPartnerCredentials()!.graphqlUrl).toBe("https://proxy.example/graphql");
  });

  it("never falls back to env inside a request scope that has no partner key", () => {
    process.env.KNOWBE4_PARTNER_API_KEY = "env-partner-key";
    const inScope = credentialStore.run(
      { tenant: { apiKey: "tenant-key", baseUrl: "https://us.api.knowbe4.com" } },
      () => getPartnerCredentials()
    );
    expect(inScope).toBeNull();
  });

  it("returns the request-scoped partner credentials in gateway mode", () => {
    const scoped = { partnerApiKey: "gw-partner-key", graphqlUrl: "https://ca.knowbe4.com/graphql" };
    const inScope = credentialStore.run({ partner: scoped }, () => getPartnerCredentials());
    expect(inScope).toEqual(scoped);
  });

  it("requirePartnerCredentials throws a configuration hint when unset", () => {
    expect(() => requirePartnerCredentials()).toThrow(PARTNER_NOT_CONFIGURED_MESSAGE);
  });
});

describe("getTenantGraphqlCredentials", () => {
  it("returns null when KNOWBE4_PRODUCT_API_KEY is not set", () => {
    expect(getTenantGraphqlCredentials()).toBeNull();
  });

  it("reads the product key and region from env", () => {
    process.env.KNOWBE4_PRODUCT_API_KEY = "product-key";
    process.env.KNOWBE4_REGION = "eu";
    expect(getTenantGraphqlCredentials()).toEqual({
      apiKey: "product-key",
      graphqlUrl: "https://eu.knowbe4.com/graphql",
    });
  });

  it("honors KNOWBE4_GRAPHQL_URL over the region", () => {
    process.env.KNOWBE4_PRODUCT_API_KEY = "product-key";
    process.env.KNOWBE4_REGION = "eu";
    process.env.KNOWBE4_GRAPHQL_URL = "https://proxy.example/graphql";
    expect(getTenantGraphqlCredentials()!.graphqlUrl).toBe("https://proxy.example/graphql");
  });

  it("is independent of KNOWBE4_API_KEY (the unrelated REST credential)", () => {
    process.env.KNOWBE4_API_KEY = "rest-key";
    expect(getTenantGraphqlCredentials()).toBeNull();
  });

  it("never falls back to env inside a request scope that has no product key", () => {
    process.env.KNOWBE4_PRODUCT_API_KEY = "env-product-key";
    const inScope = credentialStore.run(
      { tenant: { apiKey: "tenant-key", baseUrl: "https://us.api.knowbe4.com" } },
      () => getTenantGraphqlCredentials()
    );
    expect(inScope).toBeNull();
  });

  it("returns the request-scoped tenant GraphQL credentials in gateway mode", () => {
    const scoped = { apiKey: "gw-product-key", graphqlUrl: "https://ca.knowbe4.com/graphql" };
    const inScope = credentialStore.run({ tenantGraphql: scoped }, () => getTenantGraphqlCredentials());
    expect(inScope).toEqual(scoped);
  });

  it("requireTenantGraphqlCredentials throws a configuration hint when unset", () => {
    expect(() => requireTenantGraphqlCredentials()).toThrow(TENANT_GRAPHQL_NOT_CONFIGURED_MESSAGE);
  });
});

describe("graphqlRequest", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const respond = (status: number, body: unknown) => {
    fetchMock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("posts the query and variables as JSON with a bearer token", async () => {
    respond(200, { data: { ok: true } });

    await graphqlRequest("https://training.knowbe4.com/graphql", "tok-123", "query Ping { ok }", { a: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://training.knowbe4.com/graphql");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ query: "query Ping { ok }", variables: { a: 1 } });
  });

  it("returns the data envelope", async () => {
    respond(200, { data: { account: { id: 7 } } });
    const data = await graphqlRequest<{ account: { id: number } }>("https://x/graphql", "t", "query A { account { id } }");
    expect(data.account.id).toBe(7);
  });

  it("throws with every GraphQL error message", async () => {
    respond(200, { data: null, errors: [{ message: "Field 'nope' doesn't exist" }, { message: "Complexity too high" }] });
    await expect(graphqlRequest("https://x/graphql", "t", "query A { nope }")).rejects.toThrow(
      "KnowBe4 GraphQL error: Field 'nope' doesn't exist; Complexity too high"
    );
  });

  it("maps HTTP 401 to an authentication failure", async () => {
    respond(401, { message: "Unauthorized" });
    await expect(graphqlRequest("https://x/graphql", "t", "query A { a }")).rejects.toThrow(
      "Authentication failed: Unauthorized"
    );
  });

  it("maps HTTP 429 to a rate-limit error", async () => {
    respond(429, "slow down");
    await expect(graphqlRequest("https://x/graphql", "t", "query A { a }")).rejects.toThrow("Rate limit exceeded");
  });

  it("throws when the response carries no data", async () => {
    respond(200, {});
    await expect(graphqlRequest("https://x/graphql", "t", "query Empty { a }")).rejects.toThrow(
      "KnowBe4 GraphQL response for query Empty contained no data"
    );
  });
});

describe("partnerQuery", () => {
  it("throws the configuration hint when no partner key is set", async () => {
    await expect(partnerQuery("query A { a }")).rejects.toThrow(PARTNER_NOT_CONFIGURED_MESSAGE);
  });

  it("uses the partner key and regional endpoint", async () => {
    process.env.KNOWBE4_PARTNER_API_KEY = "partner-key";
    process.env.KNOWBE4_REGION = "uk";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ data: { partner: { id: 1 } } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await partnerQuery("query P { partner { id } }");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://uk.knowbe4.com/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer partner-key");
  });
});
