/**
 * Namespace credentials -- hand-written.
 *
 * The `Credentials` service resolves a tenant token plus the base URL of each
 * API host; the protocol sends the token as `Authorization: Bearer` and picks
 * the host from the operation's proto package (see `./protocol.ts`).
 */
import * as EffectConfig from "@distilled.cloud/core/config";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const DEFAULT_REGION = "us";
export const DEFAULT_GLOBAL_BASE_URL = "https://global.namespaceapis.com";
export const DEFAULT_PRIVATE_API_BASE_URL = "https://private-api.global.namespaceapis.com";

export const computeBaseUrlFor = (region: string): string =>
  `https://${region}.compute.namespaceapis.com`;
export const storageBaseUrlFor = (region: string): string =>
  `https://${region}.storage.namespaceapis.com`;

export interface Config {
  readonly token: Redacted.Redacted<string>;
  readonly region: string;
  /** `namespace.cloud.compute.*`, `builder`, `experimental.compute`: `https://<region>.compute.namespaceapis.com`. */
  readonly computeBaseUrl: string;
  /** `namespace.cloud.storage.*` (artifacts): `https://<region>.storage.namespaceapis.com`. */
  readonly storageBaseUrl: string;
  /** IAM, registry, vault, images, caches, egress and everything else global. */
  readonly globalBaseUrl: string;
  /** `namespace.private.*` (devboxes, sessions) and `namespace.cloud.github.*`. */
  readonly privateApiBaseUrl: string;
}

export interface Options {
  readonly token: Redacted.Redacted<string>;
  readonly region?: string;
  readonly computeBaseUrl?: string;
  readonly storageBaseUrl?: string;
  readonly globalBaseUrl?: string;
  readonly privateApiBaseUrl?: string;
}

export const resolveConfig = (options: Options): Config => {
  const region = options.region ?? DEFAULT_REGION;
  return {
    token: options.token,
    region,
    computeBaseUrl: options.computeBaseUrl ?? computeBaseUrlFor(region),
    storageBaseUrl: options.storageBaseUrl ?? storageBaseUrlFor(region),
    globalBaseUrl: options.globalBaseUrl ?? DEFAULT_GLOBAL_BASE_URL,
    privateApiBaseUrl: options.privateApiBaseUrl ?? DEFAULT_PRIVATE_API_BASE_URL,
  };
};

export class Credentials
  extends /*@__PURE__*/ Context.Service<Credentials, Effect.Effect<Config, ConfigError>>()(
    "NamespaceLabsCredentials",
  ) {}

const optionalUrl = (name: string) =>
  EffectConfig.option(EffectConfig.String(name)).pipe(
    EffectConfig.map((value) => (value._tag === "Some" ? value.value : undefined)),
  );

const envConfig = /*@__PURE__*/ EffectConfig.all({
  token: /*@__PURE__*/ EffectConfig.Redacted("NSC_TOKEN"),
  region: /*@__PURE__*/ EffectConfig.String("NSC_REGION").pipe(
    /*@__PURE__*/ EffectConfig.withDefault(DEFAULT_REGION),
  ),
  computeBaseUrl: /*@__PURE__*/ optionalUrl("NSC_COMPUTE_URL"),
  storageBaseUrl: /*@__PURE__*/ optionalUrl("NSC_STORAGE_URL"),
  globalBaseUrl: /*@__PURE__*/ optionalUrl("NSC_GLOBAL_URL"),
  privateApiBaseUrl: /*@__PURE__*/ optionalUrl("NSC_PRIVATE_API_URL"),
});

/**
 * Credentials from the environment: `NSC_TOKEN` (required; `nsc auth
 * generate-dev-token` or `nsc token create` mints one), `NSC_REGION`
 * (default `us`), and `NSC_COMPUTE_URL`, `NSC_STORAGE_URL`, `NSC_GLOBAL_URL`,
 * `NSC_PRIVATE_API_URL` to override a host.
 */
export const CredentialsFromEnv = /*@__PURE__*/ Layer.succeed(
  Credentials,
  /*@__PURE__*/ envConfig.pipe(
    /*@__PURE__*/ Effect.map(resolveConfig),
    /*@__PURE__*/ Effect.mapError(
      () => new ConfigError({ message: "NSC_TOKEN environment variable is required" }),
    ),
  ),
);

/** Convenience layer from a tenant token, an optional region and host overrides. */
export const credentials = (options: Options): Layer.Layer<Credentials> =>
  Layer.succeed(Credentials, Effect.succeed(resolveConfig(options)));

/** Convenience layer from a tenant token alone. */
export const fromToken = (token: Redacted.Redacted<string>): Layer.Layer<Credentials> =>
  credentials({ token });
