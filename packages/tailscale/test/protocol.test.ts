import { inspect } from "node:util";
import * as API from "@distilled.cloud/core/api";
import * as Category from "@distilled.cloud/core/category";
import * as ResponseValidation from "@distilled.cloud/core/response-validation";
import {
  mockHttpClient,
  runValidationModes,
  type MockResponse,
} from "@distilled.cloud/dev/testing";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as AST from "effect/SchemaAST";
import { describe, expect, test } from "vitest";
import { fromApiKey } from "../src/credentials.ts";
import { PolicyFileRejected, TailscaleParseError } from "../src/errors.ts";
import { TailscaleProtocol, type TailscaleOpContext } from "../src/protocol.ts";
import * as Retry from "../src/retry.ts";
import {
  getPolicyFile,
  getPolicyFileDetails,
  listUserInvites,
  previewRuleMatches,
  setPolicyFile,
} from "../src/services/tailscale.ts";
import { Header, RawResponse, RawResponseRoot, SensitiveValue } from "../src/traits.ts";

describe("Null list bodies", () => {
  test("a null list body is an empty list in both modes", async () => {
    const { lenient, strict } = await runValidationModes(
      listUserInvites({ tailnet: "-" }).pipe(
        Retry.none,
        Effect.provide(fromApiKey({ apiKey: Redacted.make("test") })),
      ),
      { body: "null" },
    );
    expect(lenient).toMatchObject({ _tag: "Success", success: [] });
    expect(strict).toMatchObject({ _tag: "Success", success: [] });
  });
});

describe("Raw-text response validation", () => {
  const HUJSON = `// keep me\n{\n  "acls": [],\n}\n`;
  const SECRET = "sentinel-secret-5c1e";

  // A raw-text body with a required header, so a response without the
  // header mismatches the output in strict mode.
  const decode = (body: string, secret: boolean) =>
    Effect.gen(function* () {
      const protocol = yield* API.Protocol;
      const request = HttpClientRequest.get("https://api.test/acl");
      const text = secret
        ? Schema.String.pipe(RawResponse(), SensitiveValue())
        : Schema.String.pipe(RawResponse());
      return yield* protocol.decode({
        response: HttpClientResponse.fromWeb(request, new Response(body, { status: 200 })),
        outputAst: Schema.Struct({
          body: text,
          eTag: Schema.String.pipe(Header("ETag")),
        }).ast,
        errors: [],
        config: {},
      });
    }).pipe(Effect.provide(TailscaleProtocol));

  const runBothModes = (body: string, secret: boolean) => {
    const runIn = (mode: typeof ResponseValidation.strict) =>
      decode(body, secret).pipe(Effect.provide(mode), Effect.result);
    return Effect.runPromise(
      Effect.all({
        lenient: runIn(ResponseValidation.lenient),
        strict: runIn(ResponseValidation.strict),
      }),
    );
  };

  test("getPolicyFile returns the HuJSON text in both modes", async () => {
    const { lenient, strict } = await runValidationModes(
      getPolicyFile({ tailnet: "-" }).pipe(
        Retry.none,
        Effect.provide(fromApiKey({ apiKey: Redacted.make("test") })),
      ),
      {
        body: HUJSON,
        headers: { "content-type": "application/hujson", etag: '"e1"' },
      },
    );
    const success = {
      _tag: "Success",
      success: { body: HUJSON, eTag: '"e1"' },
    };
    expect(lenient).toMatchObject(success);
    expect(strict).toMatchObject(success);
  });

  test("a mismatched output: lenient returns the text, strict fails with it", async () => {
    const { lenient, strict } = await runBothModes(HUJSON, false);
    expect(lenient).toMatchObject({
      _tag: "Success",
      success: { body: HUJSON },
    });
    const error = Result.isFailure(strict) && strict.failure;
    expect(error).toBeInstanceOf(TailscaleParseError);
    expect(error).toMatchObject({
      body: HUJSON,
      cause: expect.any(ResponseValidation.SchemaMismatch),
    });
  });

  test("a sensitive output: lenient redacts the text, strict fails without it", async () => {
    const { lenient, strict } = await runBothModes(SECRET, true);
    const success = Result.isSuccess(lenient) ? lenient.success : undefined;
    const body =
      typeof success === "object" && success !== null && "body" in success
        ? success.body
        : undefined;
    expect(Redacted.isRedacted(body) && Redacted.value(body)).toBe(SECRET);
    const error = Result.isFailure(strict) && strict.failure;
    expect(error).toBeInstanceOf(TailscaleParseError);
    expect(error).toMatchObject({ body: "[REDACTED]" });
    for (const result of [lenient, strict]) {
      expect(inspect(result, { depth: Infinity })).not.toContain(SECRET);
    }
  });

  test("a sensitive output: strict withholds the mismatched value from the cause", async () => {
    // The sensitive member itself mismatches, so the cause's `actual` would
    // otherwise quote the secret.
    const result = await Effect.gen(function* () {
      const protocol = yield* API.Protocol;
      const request = HttpClientRequest.get("https://api.test/acl");
      return yield* protocol.decode({
        response: HttpClientResponse.fromWeb(
          request,
          new Response(HUJSON, { status: 200, headers: { "x-token": SECRET } }),
        ),
        outputAst: Schema.Struct({
          body: Schema.String.pipe(RawResponse()),
          token: Schema.Literal("expected").pipe(Header("X-Token"), SensitiveValue()),
        }).ast,
        errors: [],
        config: {},
      });
    }).pipe(
      Effect.provide(TailscaleProtocol),
      Effect.provide(ResponseValidation.strict),
      Effect.result,
      Effect.runPromise,
    );
    const error = Result.isFailure(result) && result.failure;
    expect(error).toBeInstanceOf(TailscaleParseError);
    expect(error).toMatchObject({
      body: "[REDACTED]",
      cause: { path: ["token"], actual: "[REDACTED]" },
    });
    expect(inspect(result, { depth: Infinity })).not.toContain(SECRET);
  });
});

describe("Policy file operations", () => {
  const HUJSON = `// candidate\n{\n  "acls": [],\n}\n`;
  const seen: Array<HttpClientRequest.HttpClientRequest> = [];

  const bodyOf = (request: HttpClientRequest.HttpClientRequest): string =>
    request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

  const call = <A, E>(effect: Effect.Effect<A, E, TailscaleOpContext>, response: MockResponse) =>
    Effect.runPromise(
      effect.pipe(
        Retry.none,
        Effect.provide(fromApiKey({ apiKey: Redacted.make("test") })),
        Effect.provide(
          mockHttpClient((request) => {
            seen.push(request);
            return response;
          }),
        ),
        Effect.result,
      ),
    );

  const failureOf = <A, E>(result: Result.Result<A, E>) =>
    Result.isFailure(result) ? result.failure : undefined;

  test("previewRuleMatches sends the candidate policy as HuJSON text", async () => {
    seen.length = 0;
    const result = await call(
      previewRuleMatches({
        tailnet: "-",
        type: "user",
        previewFor: "user1@example.com",
        body: HUJSON,
      }),
      { body: JSON.stringify({ matches: [], type: "user", previewFor: "user1@example.com" }) },
    );
    expect(result).toMatchObject({ _tag: "Success", success: { matches: [] } });
    const [request] = seen;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(
      "https://api.tailscale.com/api/v2/tailnet/-/acl/preview?type=user&previewFor=user1%40example.com",
    );
    expect(request!.headers["content-type"]).toBe("application/hujson");
    expect(bodyOf(request!)).toBe(HUJSON);
  });

  test("a 400 from setPolicyFile is PolicyFileRejected with the failing tests", async () => {
    const data = [
      { user: "user1@example.com", errors: ['address "2.2.2.2:22": want: Drop, got: Accept'] },
      { user: "group:unknown@example.com", warnings: ["group is not syncing from SCIM"] },
    ];
    const result = await call(setPolicyFile({ tailnet: "-", body: HUJSON }), {
      status: 400,
      body: JSON.stringify({ message: "test(s) failed", data }),
    });
    const error = failureOf(result);
    expect(error).toBeInstanceOf(PolicyFileRejected);
    expect(error).toMatchObject({ message: "test(s) failed", body: { data } });
    expect(Category.isBadRequestError(error)).toBe(true);
  });

  test("a 400 without findings is PolicyFileRejected with the message", async () => {
    const result = await call(
      previewRuleMatches({ tailnet: "-", type: "user", previewFor: "u@example.com", body: "{" }),
      { status: 400, body: JSON.stringify({ message: "line 1, column 2: unexpected EOF" }) },
    );
    const error = failureOf(result);
    expect(error).toBeInstanceOf(PolicyFileRejected);
    expect(error).toMatchObject({ message: "line 1, column 2: unexpected EOF" });
    expect(error instanceof PolicyFileRejected && error.body?.data).toBeUndefined();
  });

  test("getPolicyFileDetails asks for details and decodes the JSON in both modes", async () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const { lenient, strict } = await runValidationModes(
      getPolicyFileDetails({ tailnet: "-" }).pipe(
        Retry.none,
        Effect.provide(fromApiKey({ apiKey: Redacted.make("test") })),
      ),
      (request) => {
        requests.push(request);
        return {
          headers: { "content-type": "application/json", etag: '"e1"' },
          body: JSON.stringify({
            acl: Base64.encode(HUJSON),
            warnings: ['"group:example": user not found: "user1@example.com"'],
            errors: null,
          }),
        };
      },
    );
    const success = {
      _tag: "Success",
      success: {
        acl: Base64.encode(HUJSON),
        warnings: ['"group:example": user not found: "user1@example.com"'],
        errors: null,
        eTag: '"e1"',
      },
    };
    expect(lenient).toMatchObject(success);
    expect(strict).toMatchObject(success);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("https://api.tailscale.com/api/v2/tailnet/-/acl?details=true");
  });
});

describe("Connection dropped while reading the body", () => {
  const droppedMidBody = (status: number) => {
    const cause = new Error("The socket connection was closed unexpectedly.");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("// keep"));
        controller.error(cause);
      },
    });
    return { cause, response: new Response(body, { status }) };
  };

  const decode = (response: Response, outputAst: AST.AST) =>
    Effect.gen(function* () {
      const protocol = yield* API.Protocol;
      const request = HttpClientRequest.get("https://api.test/acl");
      return yield* protocol.decode({
        response: HttpClientResponse.fromWeb(request, response),
        outputAst,
        errors: [],
        config: {},
      });
    }).pipe(Effect.provide(TailscaleProtocol), Effect.flip, Effect.runPromise);

  test.each([
    ["a raw-text output", Schema.Struct({ body: Schema.String.pipe(RawResponse()) }).ast],
    ["a raw list output", Schema.Array(Schema.String).pipe(RawResponseRoot()).ast],
  ])("%s cut off mid-read fails with a retryable transport error", async (_, outputAst) => {
    const { cause, response } = droppedMidBody(200);
    const error: unknown = await decode(response, outputAst);
    expect(HttpClientError.isHttpClientError(error)).toBe(true);
    const reason = HttpClientError.isHttpClientError(error) ? error.reason : undefined;
    expect(reason?._tag).toBe("TransportError");
    expect(reason?.cause).toBe(cause);
    expect(reason?.request.url).toBe("https://api.test/acl");
    expect(Category.isTransientError(error)).toBe(true);
  });
});
