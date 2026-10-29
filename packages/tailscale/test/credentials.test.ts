import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { expect, test } from "vitest";
import {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
  fromApiKey,
  fromClientCredentials,
  makeIdentityFederation,
} from "../src/credentials.ts";

const exchanges: string[] = [];

const client = HttpClient.make((request) =>
  Effect.sync(() => {
    const body =
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
    exchanges.push(new URLSearchParams(body).get("client_secret") ?? "");
    return HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({ access_token: `token-${exchanges.length}`, expires_in: 3600 }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  }),
);

const resolveWith = <A, E>(resolve: Effect.Effect<A, E>, env: Record<string, string>) =>
  resolve.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  );

test("the OAuth token is reused until the client secret changes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      exchanges.length = 0;
      const resolve = yield* Credentials;
      const first = { TAILSCALE_OAUTH_CLIENT_ID: "client", TAILSCALE_OAUTH_CLIENT_SECRET: "one" };
      const a = yield* resolveWith(resolve, first);
      const b = yield* resolveWith(resolve, first);
      const c = yield* resolveWith(resolve, { ...first, TAILSCALE_OAUTH_CLIENT_SECRET: "two" });
      expect(exchanges).toEqual(["one", "two"]);
      expect(Redacted.value(a.token)).toBe("token-1");
      expect(Redacted.value(b.token)).toBe("token-1");
      expect(Redacted.value(c.token)).toBe("token-2");
    }).pipe(
      Effect.provide(CredentialsFromEnv),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  ));

test("an empty API key counts as unset", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      exchanges.length = 0;
      const resolve = yield* Credentials;
      const config = yield* resolveWith(resolve, {
        TAILSCALE_API_KEY: "",
        TAILSCALE_OAUTH_CLIENT_ID: "client",
        TAILSCALE_OAUTH_CLIENT_SECRET: "one",
      });
      expect(exchanges).toEqual(["one"]);
      expect(Redacted.value(config.token)).toBe("token-1");
    }).pipe(
      Effect.provide(CredentialsFromEnv),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  ));

test("TAILSCALE_BASE_URL is an origin and an explicit apiBaseUrl is the API root", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fromEnv = yield* resolveWith(yield* Credentials, {
        TAILSCALE_API_KEY: "key",
        TAILSCALE_BASE_URL: "https://tailscale.example/",
      });
      expect(fromEnv.apiBaseUrl).toBe("https://tailscale.example/api/v2");
      const explicit = yield* Effect.flatten(Credentials).pipe(
        Effect.provide(
          fromApiKey({ apiKey: Redacted.make("key"), apiBaseUrl: "https://proxy.example/v2" }),
        ),
      );
      expect(explicit.apiBaseUrl).toBe("https://proxy.example/v2");
    }).pipe(
      Effect.provide(CredentialsFromEnv),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  ));

interface Sent {
  readonly url: string;
  readonly contentType: string | undefined;
  readonly form: Record<string, string>;
}

const recordingClient = (respond: (count: number) => Response) => {
  const sent: Sent[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body._tag === "Uint8Array" ? request.body : undefined;
      sent.push({
        url: request.url,
        contentType: body?.contentType,
        form: Object.fromEntries(
          new URLSearchParams(body ? new TextDecoder().decode(body.body) : ""),
        ),
      });
      return HttpClientResponse.fromWeb(request, respond(sent.length));
    }),
  );
  return { client, sent };
};

const issued = (count: number) =>
  new Response(JSON.stringify({ access_token: `token-${count}`, expires_in: 3600 }), {
    headers: { "content-type": "application/json" },
  });

const jwt = (claims: object) =>
  ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");

const FAR_FUTURE = 4_102_444_800;

test("identity federation exchanges a fresh ID token and caches the access token until the refresh window", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { client, sent } = recordingClient(issued);
      const idTokens: string[] = [];
      const resolve = yield* makeIdentityFederation({
        clientId: "client",
        idToken: Effect.sync(() => {
          const idToken = jwt({ exp: 7200, n: idTokens.length });
          idTokens.push(idToken);
          return Redacted.make(idToken);
        }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      const first = yield* resolve;
      yield* TestClock.adjust("3539 seconds");
      const cached = yield* resolve;
      yield* TestClock.adjust("1 second");
      const refreshed = yield* resolve;
      expect(sent).toEqual([
        {
          url: `${DEFAULT_API_BASE_URL}/oauth/token-exchange`,
          contentType: "application/x-www-form-urlencoded",
          form: { client_id: "client", jwt: idTokens[0] },
        },
        {
          url: `${DEFAULT_API_BASE_URL}/oauth/token-exchange`,
          contentType: "application/x-www-form-urlencoded",
          form: { client_id: "client", jwt: idTokens[1] },
        },
      ]);
      expect(Redacted.value(first.token)).toBe("token-1");
      expect(Redacted.value(cached.token)).toBe("token-1");
      expect(Redacted.value(refreshed.token)).toBe("token-2");
      expect(refreshed.tailnet).toBe("-");
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a malformed or expired ID token fails before any exchange", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { client, sent } = recordingClient(issued);
      const failure = (idToken: string) =>
        makeIdentityFederation({
          clientId: "client",
          idToken: Effect.succeed(Redacted.make(idToken)),
        }).pipe(Effect.flatten, Effect.flip, Effect.provideService(HttpClient.HttpClient, client));
      const notJwt = yield* failure("opaque-token");
      const badPayload = yield* failure("header.!!!.signature");
      const noExp = yield* failure(jwt({ sub: "repo:org/repo" }));
      const expired = yield* failure(jwt({ exp: 1 }));
      expect(notJwt._tag).toBe("ConfigError");
      expect(notJwt.message).toBe("ID token is not a JWT: expected 3 dot-separated parts, got 1");
      expect(badPayload.message).toBe("ID token payload is not base64url-encoded JSON");
      expect(noExp.message).toBe("ID token has no exp claim");
      expect(expired.message).toBe("ID token expired at 1970-01-01T00:00:01.000Z");
      expect(sent).toEqual([]);
    }),
  ));

test("a 4xx token exchange fails with its status and body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { client } = recordingClient(() => new Response("invalid audience", { status: 401 }));
      const error = yield* makeIdentityFederation({
        clientId: "client",
        idToken: Effect.succeed(Redacted.make(jwt({ exp: FAR_FUTURE }))),
      }).pipe(Effect.flatten, Effect.flip, Effect.provideService(HttpClient.HttpClient, client));
      expect(error._tag).toBe("ConfigError");
      expect(error.message).toBe(
        "Identity federation token exchange failed: status 401: invalid audience",
      );
    }),
  ));

test("TAILSCALE_IDENTITY_TOKEN selects identity federation and is reused until it changes", () => {
  const { client, sent } = recordingClient(issued);
  const one = jwt({ exp: FAR_FUTURE, n: 1 });
  const two = jwt({ exp: FAR_FUTURE, n: 2 });
  return Effect.runPromise(
    Effect.gen(function* () {
      const resolve = yield* Credentials;
      const first = {
        TAILSCALE_OAUTH_CLIENT_ID: "client",
        TAILSCALE_IDENTITY_TOKEN: one,
        TAILSCALE_BASE_URL: "https://tailscale.example",
        TAILSCALE_TAILNET: "example.com",
      };
      const a = yield* resolveWith(resolve, first);
      const b = yield* resolveWith(resolve, { ...first, TAILSCALE_OAUTH_CLIENT_SECRET: "" });
      const c = yield* resolveWith(resolve, { ...first, TAILSCALE_IDENTITY_TOKEN: two });
      expect(sent.map(({ url, form }) => [url, form.jwt])).toEqual([
        ["https://tailscale.example/api/v2/oauth/token-exchange", one],
        ["https://tailscale.example/api/v2/oauth/token-exchange", two],
      ]);
      expect(Redacted.value(a.token)).toBe("token-1");
      expect(Redacted.value(b.token)).toBe("token-1");
      expect(Redacted.value(c.token)).toBe("token-2");
      expect(c.tailnet).toBe("example.com");
    }).pipe(
      Effect.provide(CredentialsFromEnv),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  );
});

test("an identity token conflicts with an API key or a client secret", () => {
  const { client, sent } = recordingClient(issued);
  const idToken = jwt({ exp: FAR_FUTURE });
  return Effect.runPromise(
    Effect.gen(function* () {
      const resolve = yield* Credentials;
      const failure = (env: Record<string, string>) =>
        Effect.flip(resolveWith(resolve, env)).pipe(Effect.map((error) => error.message));
      expect(yield* failure({ TAILSCALE_API_KEY: "key", TAILSCALE_IDENTITY_TOKEN: idToken })).toBe(
        "TAILSCALE_API_KEY cannot be set together with TAILSCALE_OAUTH_CLIENT_ID, TAILSCALE_OAUTH_CLIENT_SECRET or TAILSCALE_IDENTITY_TOKEN",
      );
      expect(
        yield* failure({
          TAILSCALE_OAUTH_CLIENT_ID: "client",
          TAILSCALE_OAUTH_CLIENT_SECRET: "secret",
          TAILSCALE_IDENTITY_TOKEN: idToken,
        }),
      ).toBe("TAILSCALE_OAUTH_CLIENT_SECRET and TAILSCALE_IDENTITY_TOKEN cannot both be set");
      expect(yield* failure({ TAILSCALE_IDENTITY_TOKEN: idToken })).toBe(
        "TAILSCALE_OAUTH_CLIENT_ID and one of TAILSCALE_OAUTH_CLIENT_SECRET or TAILSCALE_IDENTITY_TOKEN are required",
      );
      expect(sent).toEqual([]);
    }).pipe(
      Effect.provide(CredentialsFromEnv),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  );
});

test("client credentials send scope and tags only when set", () => {
  const { client, sent } = recordingClient(issued);
  const exchange = (config: { readonly scope?: string; readonly tags?: string }) =>
    Effect.flatten(Credentials).pipe(
      Effect.provide(
        fromClientCredentials({
          clientId: "client",
          clientSecret: Redacted.make("secret"),
          ...config,
        }),
      ),
    );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* exchange({});
      yield* exchange({ scope: "devices:core", tags: "tag:ci tag:server" });
      expect(sent.map(({ form }) => form)).toEqual([
        { grant_type: "client_credentials", client_id: "client", client_secret: "secret" },
        {
          grant_type: "client_credentials",
          client_id: "client",
          client_secret: "secret",
          scope: "devices:core",
          tags: "tag:ci tag:server",
        },
      ]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  );
});
