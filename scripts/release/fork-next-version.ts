import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { publishablePackages, sharedVersion } from "../package-manifest.ts";
import { exec } from "./exec.ts";

const FORK_TAG = /^refs\/tags\/v.+-fork\.(\d+)$/;

const forkTagNumbers = Effect.try(() =>
  exec("git", ["ls-remote", "--tags", "--refs", "origin", "refs/tags/v*-fork.*"], { quiet: true })
    .stdout.split("\n")
    .map((line) => FORK_TAG.exec(line.split("\t")[1] ?? "")?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number),
);

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../..");
  const upstream = yield* sharedVersion(yield* publishablePackages(root, "packages"));
  const next = Math.max(0, ...(yield* forkTagNumbers)) + 1;
  yield* Console.log(`${upstream}-fork.${next}`);
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
