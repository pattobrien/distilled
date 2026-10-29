# @distilled.cloud/namespacelabs

Effect-native [Namespace](https://namespace.so) SDK, generated from the
protobuf API Namespace publishes at
[buf.build/namespace/cloud](https://buf.build/namespace/cloud).

## Spec source

Namespace does not publish OpenAPI. Its API is defined in protobuf and served
over gRPC and Connect, and the Buf Schema Registry module is what the `nsc`
CLI, the Go SDK and the official TypeScript SDK are generated from. The module's
own files (`proto/namespace/**`) are mirrored; its one dependency, Bazel's
build-event protos, is not read by anything the generator converts.

Convert writes one Smithy model per proto service and maps each unary RPC to
`POST /<package>.<Service>/<Method>` with a proto3 JSON body (camelCase
fields, 64-bit integers as strings, `bytes` as base64). Streaming RPCs are
skipped; most have a polling or `*Sync` counterpart.

The package is `namespacelabs` (Namespace's GitHub org and npm scope) rather
than `namespace`, so it does not shadow Alchemy's own `Namespace` export when
both are imported.

## Services

Every service is `v1beta`. The barrel export is the proto package plus the
service, so `ComputeService` is `compute`, `CommandService` is
`computeCommand`, `TokenService` is `iamToken` and the devbox API is
`privateDevbox`.

| Host | Services |
| --- | --- |
| `https://<region>.compute.namespaceapis.com` | `compute`, `computeCommand`, `computeStorage`, `computeUsage`, `computeObservability`, `computeManagement`, `builder`, `experimentalComputeReservation` |
| `https://<region>.storage.namespaceapis.com` | `artifacts` |
| `https://global.namespaceapis.com` | `iamTenant`, `iamTenantMembership`, `iamToken`, `registry`, `vault`, `image`, `egress`, `bazel`, `bazelCache`, `gradleCache`, `httpcache`, `buildkiteJobs`, `buildkiteQueue`, `testing`, `audit`, `experimentalRemote*` |
| `https://private-api.global.namespaceapis.com` | `privateDevbox`, `privateDevboxExtra`, `privateDevboxWireAgent`, `privateInstance`, `privateUserSessions`, `githubProfile`, `githubJobs`, `githubImage` |

The protocol picks the host from the operation's proto package. The
`namespace.private.*` services are in the public module and used by the
official SDKs, but Namespace lists them under no stability promise.

## Installation

```bash
npm install @distilled.cloud/namespacelabs effect
```

## Quick start

```ts
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NamespaceLabs from "@distilled.cloud/namespacelabs";

const program = Effect.gen(function* () {
  const created = yield* NamespaceLabs.compute.createInstance({
    shape: { virtualCpu: 2, memoryMegabytes: 4096, os: "linux", machineArch: "amd64" },
    deadline: new Date(Date.now() + 10 * 60 * 1000),
  });
  const instanceId = created.metadata!.instanceId!;
  const instance = yield* NamespaceLabs.compute.describeInstance({ instanceId });
  yield* NamespaceLabs.compute.destroyInstance({ instanceId });
  return instance.metadata?.status;
});

const Live = Layer.mergeAll(
  FetchHttpClient.layer,
  NamespaceLabs.CredentialsFromEnv,
  NamespaceLabs.NamespaceLabsProtocol,
);

program.pipe(Effect.provide(Live), Effect.runPromise);
```

## Auth

`NSC_TOKEN` as `Authorization: Bearer`. Mint one with
`nsc auth generate-dev-token`, `nsc token create --grant ...`, or
`iamToken.issueTenantTokenWithOidc` from a CI identity token. Optional:
`NSC_REGION` (default `us`) selects the compute and storage hosts;
`NSC_COMPUTE_URL`, `NSC_STORAGE_URL`, `NSC_GLOBAL_URL` and
`NSC_PRIVATE_API_URL` override a host. `credentials({ token, region })` and
`fromToken(token)` build the same layer in code.

Tokens, issued private keys and the third-party API keys a devbox template
carries are `Redacted` in responses and accepted as `string | Redacted<string>`
in requests.
