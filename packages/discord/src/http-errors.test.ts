import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { credentials } from "./credentials.ts";
import { Forbidden, NotFound } from "./errors.ts";
import * as Retry from "./retry.ts";
import { getGuild } from "./services/discord.ts";

const respond = (status: number, body: unknown) =>
  Layer.mergeAll(
    credentials({ token: "test" }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(body, { status })),
        ),
      ),
    ),
  );

test("getGuild surfaces a 404 as a catchable NotFound", () =>
  Effect.runPromise(
    getGuild({ guild_id: "1" }).pipe(
      Retry.none,
      Effect.map(() => "found"),
      Effect.catchTag("NotFound", (error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(NotFound);
          return error.message;
        }),
      ),
      Effect.provide(respond(404, { message: "Unknown Guild", code: 10004 })),
      Effect.map((result) => expect(result).toBe("Unknown Guild")),
    ),
  ));

test("getGuild surfaces a 403 as a catchable Forbidden", () =>
  Effect.runPromise(
    getGuild({ guild_id: "1" }).pipe(
      Retry.none,
      Effect.map(() => "found"),
      Effect.catchTag("Forbidden", (error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(Forbidden);
          return error.message;
        }),
      ),
      Effect.provide(respond(403, { message: "Missing Access", code: 50001 })),
      Effect.map((result) => expect(result).toBe("Missing Access")),
    ),
  ));
