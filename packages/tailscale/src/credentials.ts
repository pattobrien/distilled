import * as EffectConfig from "@distilled.cloud/core/config";
import { ConfigError } from "@distilled.cloud/core/errors";
import { refreshing } from "@distilled.cloud/core/token-cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { TokenRequestFailed } from "./errors.ts";

export const DEFAULT_API_BASE_URL = "https://api.tailscale.com/api/v2";

const TOKEN_REFRESH_WINDOW_MS = 60_000;

export interface Config {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

/**
 * Resolves the current credentials on every request. `CredentialsFromEnv`
 * reads and checks the environment when it is built, so the effect fails
 * only when the OAuth token exchange it makes at run time fails, with
 * {@link TokenRequestFailed}.
 */
export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<Config, TokenRequestFailed>
>()("TailscaleCredentials") {}

export const fromApiKey = (config: {
  readonly apiKey: Redacted.Redacted<string>;
  /**
   * The API root, including `/api/v2`, used as given. Default
   * `DEFAULT_API_BASE_URL`. Unlike `TAILSCALE_BASE_URL`, it is not an origin.
   */
  readonly apiBaseUrl?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      token: config.apiKey,
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    }),
  );

export interface ClientCredentialsConfig {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly scope?: string;
  /**
   * The API root, including `/api/v2`, used as given. Default
   * `DEFAULT_API_BASE_URL`. Unlike `TAILSCALE_BASE_URL`, it is not an origin.
   */
  readonly apiBaseUrl?: string;
  /** Sent as the exchange's `tailnet` parameter to scope the token to an API-only tailnet. */
  readonly tokenTailnet?: string;
}

const TokenResponse = Schema.Struct({
  access_token: Schema.Redacted(Schema.String),
  expires_in: Schema.Number,
});

const exchangeFailed = (reason: string, status: number | undefined) =>
  new TokenRequestFailed({ message: `OAuth token exchange failed: ${reason}`, status });

interface CachedToken {
  readonly config: Config;
  readonly refreshAt: number;
}

const requestToken = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
) =>
  client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.mapError((cause) => exchangeFailed(cause.message, cause.response?.status)),
    Effect.flatMap((response) =>
      HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
        Effect.mapError((cause) => exchangeFailed(cause.message, response.status)),
      ),
    ),
  );

const cacheToken = (
  apiBaseUrl: string,
  exchange: Effect.Effect<typeof TokenResponse.Type, TokenRequestFailed>,
): Effect.Effect<Config, TokenRequestFailed> => {
  const mint = Effect.map(exchange, (token): CachedToken => ({
    config: {
      token: token.access_token,
      apiBaseUrl,
    },
    refreshAt: Date.now() + token.expires_in * 1000 - TOKEN_REFRESH_WINDOW_MS,
  }));
  return refreshing(mint, (cached) => cached.refreshAt, {
    onTimeout: (timeoutMs) =>
      new TokenRequestFailed({
        message: `Tailscale OAuth token exchange timed out after ${timeoutMs / 1000} s`,
      }),
  }).pipe(Effect.map((cached) => cached.config));
};

/**
 * Builds the OAuth client-credentials token cache. The returned effect posts
 * the exchange through the captured `HttpClient`, reuses the token until
 * 60 seconds before `expires_in`, and concurrent resolutions of a cold or
 * stale token share one exchange (core `refreshing`). A failed exchange
 * fails the returned effect with {@link TokenRequestFailed}.
 */
export const makeClientCredentials = (
  config: ClientCredentialsConfig,
): Effect.Effect<Effect.Effect<Config, TokenRequestFailed>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    return cacheToken(
      apiBaseUrl,
      requestToken(
        client,
        HttpClientRequest.post(`${apiBaseUrl}/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            client_id: config.clientId,
            client_secret: Redacted.value(config.clientSecret),
            ...(config.scope ? { scope: config.scope } : {}),
            ...(config.tokenTailnet ? { tailnet: config.tokenTailnet } : {}),
          }),
        ),
      ),
    );
  });

export const fromClientCredentials = (
  config: ClientCredentialsConfig,
): Layer.Layer<Credentials, never, HttpClient.HttpClient> =>
  Layer.effect(Credentials, makeClientCredentials(config));

export interface IdentityFederationConfig<R = never> {
  /** The ID of the Tailscale federated identity. */
  readonly clientId: string;
  /** Returns the identity provider's OIDC ID token. Runs before every exchange. */
  readonly idToken: Effect.Effect<Redacted.Redacted<string>, TokenRequestFailed, R>;
  /**
   * The API root, including `/api/v2`, used as given. Default
   * `DEFAULT_API_BASE_URL`. Unlike `TAILSCALE_BASE_URL`, it is not an origin.
   */
  readonly apiBaseUrl?: string;
}

const IdTokenClaims = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Struct({ exp: Schema.optional(Schema.Number) }))),
);

const idTokenProblem = (idToken: Redacted.Redacted<string>, now: number): string | undefined => {
  const parts = Redacted.value(idToken).split(".");
  if (parts.length !== 3) {
    return `is not a JWT: expected 3 dot-separated parts, got ${parts.length}`;
  }
  const claims = Schema.decodeUnknownOption(IdTokenClaims)(parts[1]);
  if (Option.isNone(claims)) {
    return "has a payload that is not base64url-encoded JSON";
  }
  const exp = claims.value.exp;
  if (exp === undefined) {
    return "has no exp claim";
  }
  if (now >= exp * 1000) {
    return `expired at ${new Date(exp * 1000).toISOString()}`;
  }
  return undefined;
};

/**
 * Builds the workload identity federation token cache. Each exchange runs
 * `idToken` in the context the layer was built with, and posts the ID token
 * to `{apiBaseUrl}/oauth/token-exchange` through the captured `HttpClient`.
 * Caching matches `makeClientCredentials`. A malformed, `exp`-less or expired
 * ID token, or a failed exchange, fails the returned effect with
 * {@link TokenRequestFailed}.
 */
export const makeIdentityFederation = <R = never>(
  config: IdentityFederationConfig<R>,
): Effect.Effect<Effect.Effect<Config, TokenRequestFailed>, never, HttpClient.HttpClient | R> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const context = yield* Effect.context<R>();
    const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const exchange = Effect.gen(function* () {
      const idToken = yield* Effect.provideContext(config.idToken, context);
      const problem = idTokenProblem(idToken, Date.now());
      if (problem !== undefined) {
        return yield* exchangeFailed(`the ID token ${problem}`, undefined);
      }
      return yield* requestToken(
        client,
        HttpClientRequest.post(`${apiBaseUrl}/oauth/token-exchange`).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: config.clientId,
            jwt: Redacted.value(idToken),
          }),
        ),
      );
    });
    return cacheToken(apiBaseUrl, exchange);
  });

export const fromIdentityFederation = <R = never>(
  config: IdentityFederationConfig<R>,
): Layer.Layer<Credentials, never, HttpClient.HttpClient | R> =>
  Layer.effect(Credentials, makeIdentityFederation(config));

/** `TAILSCALE_BASE_URL` is the origin. An explicit API root ending in `/api/v2` is kept. */
const apiBaseUrlFromOrigin = (origin: string): string => {
  const trimmed = origin.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v2") ? trimmed : `${trimmed}/api/v2`;
};

const BOTH_METHODS =
  "TAILSCALE_API_KEY cannot be set together with TAILSCALE_OAUTH_CLIENT_ID, TAILSCALE_OAUTH_CLIENT_SECRET or TAILSCALE_IDENTITY_TOKEN";

const BOTH_OAUTH_METHODS =
  "TAILSCALE_OAUTH_CLIENT_SECRET and TAILSCALE_IDENTITY_TOKEN cannot both be set";

/** An empty variable counts as unset. */
const nonEmpty = (value: Option.Option<Redacted.Redacted<string>>) =>
  Option.filter(value, (v) => Redacted.value(v).length > 0);

const EnvConfig = /*@__PURE__*/ EffectConfig.all({
  apiKey: EffectConfig.option(EffectConfig.Redacted("TAILSCALE_API_KEY")).pipe(
    EffectConfig.map(nonEmpty),
  ),
  clientId: EffectConfig.option(EffectConfig.String("TAILSCALE_OAUTH_CLIENT_ID")),
  clientSecret: EffectConfig.option(EffectConfig.Redacted("TAILSCALE_OAUTH_CLIENT_SECRET")).pipe(
    EffectConfig.map(nonEmpty),
  ),
  identityToken: EffectConfig.option(EffectConfig.Redacted("TAILSCALE_IDENTITY_TOKEN")).pipe(
    EffectConfig.map(nonEmpty),
  ),
  origin: EffectConfig.option(EffectConfig.String("TAILSCALE_BASE_URL")),
});

/**
 * Reads `TAILSCALE_API_KEY`, `TAILSCALE_OAUTH_CLIENT_ID`,
 * `TAILSCALE_OAUTH_CLIENT_SECRET`, `TAILSCALE_IDENTITY_TOKEN` and
 * `TAILSCALE_BASE_URL` through `@distilled.cloud/core/config`, so a provided
 * `ConfigProvider` supplies them. They are read, and checked, once: when the
 * layer is built. Two methods at once, a client ID without a secret or an ID
 * token, no method, or a malformed, `exp`-less or expired ID token fails the
 * layer with `ConfigError`. The OAuth token cache belongs to the layer.
 */
export const CredentialsFromEnv: Layer.Layer<Credentials, ConfigError, HttpClient.HttpClient> =
  /*@__PURE__*/ Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const env = yield* EnvConfig.pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              message: `Failed to read Tailscale configuration: ${cause.message}`,
            }),
        ),
      );
      const apiKey = Option.getOrUndefined(env.apiKey);
      const clientId = Option.getOrUndefined(env.clientId);
      const clientSecret = Option.getOrUndefined(env.clientSecret);
      const identityToken = Option.getOrUndefined(env.identityToken);
      const apiBaseUrl = Option.match(env.origin, {
        onNone: () => DEFAULT_API_BASE_URL,
        onSome: apiBaseUrlFromOrigin,
      });
      if (apiKey && (clientId || clientSecret || identityToken)) {
        return yield* new ConfigError({ message: BOTH_METHODS });
      }
      if (clientSecret && identityToken) {
        return yield* new ConfigError({ message: BOTH_OAUTH_METHODS });
      }
      if (apiKey) {
        return Effect.succeed({
          token: apiKey,
          apiBaseUrl,
        });
      }
      if (clientId && clientSecret) {
        return yield* makeClientCredentials({
          clientId,
          clientSecret,
          apiBaseUrl,
        });
      }
      if (clientId && identityToken) {
        const problem = idTokenProblem(identityToken, Date.now());
        if (problem !== undefined) {
          return yield* new ConfigError({ message: `TAILSCALE_IDENTITY_TOKEN ${problem}` });
        }
        return yield* makeIdentityFederation({
          clientId,
          idToken: Effect.succeed(identityToken),
          apiBaseUrl,
        });
      }
      if (clientId || clientSecret || identityToken) {
        return yield* new ConfigError({
          message:
            "TAILSCALE_OAUTH_CLIENT_ID and one of TAILSCALE_OAUTH_CLIENT_SECRET or TAILSCALE_IDENTITY_TOKEN are required",
        });
      }
      return yield* new ConfigError({
        message:
          "TAILSCALE_API_KEY, or TAILSCALE_OAUTH_CLIENT_ID with TAILSCALE_OAUTH_CLIENT_SECRET or TAILSCALE_IDENTITY_TOKEN, is required",
      });
    }),
  );
