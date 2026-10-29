import * as Redacted from "effect/Redacted";
import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/credentials.ts";
import { baseUrlFor, hostFor } from "../src/protocol.ts";

const creds = resolveConfig({ token: Redacted.make("test"), region: "eu" });

describe("hostFor", () => {
  test.each([
    ["/namespace.cloud.compute.v1beta.ComputeService/ListInstances", "compute"],
    ["/namespace.cloud.compute.v1beta.StorageService/ListCacheVolumes", "compute"],
    ["/namespace.cloud.builder.v1beta.BuilderService/GetBuilderConfiguration", "compute"],
    ["/namespace.experimental.compute.ReservationService/ListReservations", "compute"],
    ["/namespace.cloud.storage.v1beta.ArtifactsService/ListArtifacts", "storage"],
    ["/namespace.cloud.iam.v1beta.TokenService/ListRevokableTokens", "global"],
    ["/namespace.cloud.registry.v1beta.ContainerRegistryService/ListImages", "global"],
    ["/namespace.cloud.vault.v1beta.VaultService/ListObjects", "global"],
    ["/namespace.cloud.integrations.bazel.v1beta.BazelCacheService/EnsureBazelCache", "global"],
    ["/namespace.cloud.github.v1beta.ProfileService/ListProfiles", "privateApi"],
    ["/namespace.private.devbox.v1beta.DevBoxService/List", "privateApi"],
    ["/namespace.private.sessions.v1beta.UserSessionsService/ListSessions", "privateApi"],
  ] as const)("%s → %s", (uri, host) => {
    expect(hostFor(uri)).toBe(host);
  });
});

describe("baseUrlFor", () => {
  test("regional hosts follow the configured region", () => {
    expect(baseUrlFor(creds, "/namespace.cloud.compute.v1beta.ComputeService/ListInstances")).toBe(
      "https://eu.compute.namespaceapis.com",
    );
    expect(
      baseUrlFor(creds, "/namespace.cloud.storage.v1beta.ArtifactsService/ListArtifacts"),
    ).toBe("https://eu.storage.namespaceapis.com");
  });

  test("global and private hosts do not", () => {
    expect(baseUrlFor(creds, "/namespace.cloud.iam.v1beta.TenantService/ListTenants")).toBe(
      "https://global.namespaceapis.com",
    );
    expect(baseUrlFor(creds, "/namespace.private.devbox.v1beta.DevBoxService/List")).toBe(
      "https://private-api.global.namespaceapis.com",
    );
  });

  test("an explicit host override wins", () => {
    const custom = resolveConfig({
      token: Redacted.make("test"),
      computeBaseUrl: "http://localhost:8080",
    });
    expect(baseUrlFor(custom, "/namespace.cloud.compute.v1beta.ComputeService/ListInstances")).toBe(
      "http://localhost:8080",
    );
    expect(
      baseUrlFor(custom, "/namespace.cloud.storage.v1beta.ArtifactsService/ListArtifacts"),
    ).toBe("https://us.storage.namespaceapis.com");
  });
});
