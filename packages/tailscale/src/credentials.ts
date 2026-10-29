import * as EffectConfig from "@distilled.cloud/core/config";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

export const DEFAULT_API_BASE_URL = "https://api.tailscale.com/api/v2";
export const DEFAULT_TAILNET = "-";

const TOKEN_REFRESH_WINDOW_MS = 60_000;

export interface Config {
  readonly token: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
  readonly tailnet: string;
}

export class Credentials extends Context.Service<Credentials, Effect.Effect<Config, ConfigError>>()(
  "TailscaleCredentials",
) {}

export const fromApiKey = (config: {
  readonly apiKey: Redacted.Redacted<string>;
  /**
   * The API root, including `/api/v2`, used as given. Default
   * `DEFAULT_API_BASE_URL`. Unlike `TAILSCALE_BASE_URL`, it is not an origin.
   */
  readonly apiBaseUrl?: string;
  readonly tailnet?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      token: config.apiKey,
      apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      tailnet: config.tailnet ?? DEFAULT_TAILNET,
    }),
  );

export interface ClientCredentialsConfig {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly scope?: string;
  /** Space-delimited tags for a token with the `devices:core`, `auth_keys` or `all` scope. */
  readonly tags?: string;
  /**
   * The API root, including `/api/v2`, used as given. Default
   * `DEFAULT_API_BASE_URL`. Unlike `TAILSCALE_BASE_URL`, it is not an origin.
   */
  readonly apiBaseUrl?: string;
  readonly tailnet?: string;
  /** Sent as the exchange's `tailnet` parameter to scope the token to an API-only tailnet. */
  readonly tokenTailnet?: string;
}

const TokenResponse = Schema.Struct({
  access_token: Schema.Redacted(Schema.String),
  expires_in: Schema.Number,
});

interface CachedToken {
  readonly config: Config;
  readonly refreshAt: number;
}

const cacheToken = (
  apiBaseUrl: string,
  tailnet: string,
  exchange: Effect.Effect<typeof TokenResponse.Type, ConfigError>,
): Effect.Effect<Effect.Effect<Config, ConfigError>> =>
  Effect.map(SynchronizedRef.make(Option.none<CachedToken>()), (cache) =>
    SynchronizedRef.modifyEffect(cache, (cached) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (Option.isSome(cached) && now < cached.value.refreshAt) {
          return [cached.value.config, cached] as const;
        }
        const token = yield* exchange;
        const next: CachedToken = {
          config: {
            token: token.access_token,
            apiBaseUrl,
            tailnet,
          },
          refreshAt: now + token.expires_in * 1000 - TOKEN_REFRESH_WINDOW_MS,
        };
        return [next.config, Option.some(next)] as const;
      }),
    ),
  );

/**
 * Builds the OAuth client-credentials token cache. The returned effect posts
 * the exchange through the captured `HttpClient`, reuses the token until
 * 60 seconds before `expires_in`, and serializes refreshes so concurrent
 * resolutions of a stale token make one exchange.
 */
export const makeClientCredentials = (
  config: ClientCredentialsConfig,
): Effect.Effect<Effect.Effect<Config, ConfigError>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const exchange = client
      .execute(
        HttpClientRequest.post(`${apiBaseUrl}/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            client_id: config.clientId,
            client_secret: Redacted.value(config.clientSecret),
            ...(config.scope ? { scope: config.scope } : {}),
            ...(config.tags ? { tags: config.tags } : {}),
            ...(config.tokenTailnet ? { tailnet: config.tokenTailnet } : {}),
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
        Effect.mapError(
          (cause) =>
            new ConfigError({
              message: `OAuth token exchange failed: ${cause.message}`,
            }),
        ),
      );
    return yield* cacheToken(apiBaseUrl, config.tailnet ?? DEFAULT_TAILNET, exchange);
  });

export const fromClientCredentials = (
  config: ClientCredentialsConfig,
): Layer.Layer<Credentials, never, HttpClient.HttpClient> =>
  Layer.effect(Credentials, makeClientCredentials(config));

export interface IdentityFederationConfig {
  /** The ID of the Tailscale OAuth client that trusts the identity provider. */
  readonly clientId: string;
  /** Returns the identity provider's OIDC ID token. Run before every exchange. */
  readonly idToken: Effect.Effect<Redacted.Redacted<string>, ConfigError>;
  /**
   * The API root, including `/api/v2`, used as given. Default
   * `DEFAULT_API_BASE_URL`. Unlike `TAILSCALE_BASE_URL`, it is not an origin.
   */
  readonly apiBaseUrl?: string;
  readonly tailnet?: string;
}

const IdTokenClaims = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Struct({ exp: Schema.optional(Schema.Number) }))),
);

const validateIdToken = (
  idToken: Redacted.Redacted<string>,
): Effect.Effect<Redacted.Redacted<string>, ConfigError> =>
  Effect.gen(function* () {
    const parts = Redacted.value(idToken).split(".");
    if (parts.length !== 3) {
      return yield* new ConfigError({
        message: `ID token is not a JWT: expected 3 dot-separated parts, got ${parts.length}`,
      });
    }
    const claims = yield* Schema.decodeUnknownEffect(IdTokenClaims)(parts[1]).pipe(
      Effect.mapError(
        () => new ConfigError({ message: "ID token payload is not base64url-encoded JSON" }),
      ),
    );
    if (claims.exp === undefined) {
      return yield* new ConfigError({ message: "ID token has no exp claim" });
    }
    const now = yield* Clock.currentTimeMillis;
    if (now >= claims.exp * 1000) {
      return yield* new ConfigError({
        message: `ID token expired at ${new Date(claims.exp * 1000).toISOString()}`,
      });
    }
    return idToken;
  });

const federationError = (message: string) =>
  new ConfigError({ message: `Identity federation token exchange failed: ${message}` });

/**
 * Builds the workload identity federation token cache. Each exchange runs
 * `idToken`, rejects a malformed or expired ID token, and posts it to
 * `{apiBaseUrl}/oauth/token-exchange` through the captured `HttpClient`.
 * Caching and refresh serialization match `makeClientCredentials`.
 */
export const makeIdentityFederation = (
  config: IdentityFederationConfig,
): Effect.Effect<Effect.Effect<Config, ConfigError>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const exchange = Effect.gen(function* () {
      const idToken = yield* Effect.flatMap(config.idToken, validateIdToken);
      const response = yield* client
        .execute(
          HttpClientRequest.post(`${apiBaseUrl}/oauth/token-exchange`).pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: config.clientId,
              jwt: Redacted.value(idToken),
            }),
          ),
        )
        .pipe(Effect.mapError((cause) => federationError(cause.message)));
      if (response.status >= 400) {
        const body = yield* response.text.pipe(
          Effect.mapError((cause) =>
            federationError(`status ${response.status}: ${cause.message}`),
          ),
        );
        return yield* federationError(`status ${response.status}: ${body}`);
      }
      return yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
        Effect.mapError((cause) => federationError(cause.message)),
      );
    });
    return yield* cacheToken(apiBaseUrl, config.tailnet ?? DEFAULT_TAILNET, exchange);
  });

export const fromIdentityFederation = (
  config: IdentityFederationConfig,
): Layer.Layer<Credentials, never, HttpClient.HttpClient> =>
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

const EnvConfig = EffectConfig.all({
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
  tailnet: EffectConfig.String("TAILSCALE_TAILNET").pipe(EffectConfig.withDefault(DEFAULT_TAILNET)),
  origin: EffectConfig.option(EffectConfig.String("TAILSCALE_BASE_URL")),
});

type EnvOAuthConfig =
  | {
      readonly _tag: "ClientCredentials";
      readonly clientId: string;
      readonly clientSecret: Redacted.Redacted<string>;
      readonly apiBaseUrl: string;
      readonly tailnet: string;
    }
  | {
      readonly _tag: "IdentityFederation";
      readonly clientId: string;
      readonly identityToken: Redacted.Redacted<string>;
      readonly apiBaseUrl: string;
      readonly tailnet: string;
    };

interface EnvOAuth {
  readonly config: EnvOAuthConfig;
  readonly resolve: Effect.Effect<Config, ConfigError>;
}

const makeEnvOAuth = (config: EnvOAuthConfig) =>
  config._tag === "ClientCredentials"
    ? makeClientCredentials(config)
    : makeIdentityFederation({
        clientId: config.clientId,
        idToken: Effect.succeed(config.identityToken),
        apiBaseUrl: config.apiBaseUrl,
        tailnet: config.tailnet,
      });

/**
 * Reads `TAILSCALE_API_KEY`, `TAILSCALE_OAUTH_CLIENT_ID`,
 * `TAILSCALE_OAUTH_CLIENT_SECRET`, `TAILSCALE_IDENTITY_TOKEN`,
 * `TAILSCALE_TAILNET` and `TAILSCALE_BASE_URL` through
 * `@distilled.cloud/core/config` on every resolution, so a provided
 * `ConfigProvider` supplies them. The OAuth token cache belongs to the layer
 * and is rebuilt when the OAuth variables change.
 */
export const CredentialsFromEnv: Layer.Layer<Credentials, never, HttpClient.HttpClient> =
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const oauth = yield* SynchronizedRef.make(Option.none<EnvOAuth>());
      const resolveOAuth = (config: EnvOAuthConfig) =>
        SynchronizedRef.modifyEffect(oauth, (current) =>
          Option.isSome(current) && Equal.equals(current.value.config, config)
            ? Effect.succeed([current.value.resolve, current] as const)
            : makeEnvOAuth(config).pipe(
                Effect.provideService(HttpClient.HttpClient, client),
                Effect.map((resolve) => [resolve, Option.some({ config, resolve })] as const),
              ),
        ).pipe(Effect.flatten);
      return Effect.gen(function* () {
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
          return {
            token: apiKey,
            apiBaseUrl,
            tailnet: env.tailnet,
          };
        }
        if (clientId && clientSecret) {
          return yield* resolveOAuth({
            _tag: "ClientCredentials",
            clientId,
            clientSecret,
            apiBaseUrl,
            tailnet: env.tailnet,
          });
        }
        if (clientId && identityToken) {
          return yield* resolveOAuth({
            _tag: "IdentityFederation",
            clientId,
            identityToken,
            apiBaseUrl,
            tailnet: env.tailnet,
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
      });
    }),
  );
