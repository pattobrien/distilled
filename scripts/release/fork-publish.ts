import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { publishablePackages, sharedVersion, type WorkspacePackage } from "../package-manifest.ts";
import { exec } from "./exec.ts";

const UPSTREAM_SCOPE = "@distilled.cloud/";
const FORK_SCOPE = "@pattobrien/distilled-";
const REGISTRY = "https://npm.pkg.github.com";
const REPOSITORY = "git+https://github.com/pattobrien/distilled.git";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export class InvalidForkVersion extends Data.TaggedError("InvalidForkVersion")<{
  readonly message: string;
  readonly version: string;
}> {}

const decodePackResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ filename: Schema.String })),
);

const forkName = (name: string) => name.replace(UPSTREAM_SCOPE, FORK_SCOPE);

const aliasDependencies = (dependencies: unknown, version: string) =>
  Predicate.isObject(dependencies)
    ? Object.fromEntries(
        Object.entries(dependencies).map(([name, range]) => [
          name,
          name.startsWith(UPSTREAM_SCOPE) ? `npm:${forkName(name)}@${version}` : range,
        ]),
      )
    : dependencies;

const forkManifest = ({ dir, manifest, raw }: WorkspacePackage, version: string) => ({
  ...raw,
  name: forkName(manifest.name),
  version,
  ...Object.fromEntries(
    DEPENDENCY_FIELDS.filter((field) => field in raw).map((field) => [
      field,
      aliasDependencies(raw[field], version),
    ]),
  ),
  repository: { type: "git", url: REPOSITORY, directory: dir },
  publishConfig: { registry: REGISTRY },
});

const pack = Effect.fn(function* (
  root: string,
  destination: string,
  pkg: WorkspacePackage,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, pkg.dir);
  const manifest = forkManifest(pkg, version);
  yield* fs.writeFileString(
    path.join(dir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const packed = yield* Effect.try(() =>
    exec("pnpm", ["pack", "--json", "--pack-destination", destination], { cwd: dir, quiet: true }),
  );
  const { filename } = yield* decodePackResult(packed.stdout);
  return { spec: `${manifest.name}@${version}`, tarball: filename };
});

const publish = Effect.fn(function* ({ spec, tarball }: { spec: string; tarball: string }) {
  const existing = yield* Effect.try(() =>
    exec("npm", ["view", spec, "version", "--registry", REGISTRY], { quiet: true, nothrow: true }),
  );
  if (existing.exitCode === 0 && existing.stdout.trim() !== "") {
    return yield* Console.log(`${spec} skipped, already published`);
  }
  yield* Effect.try(() =>
    exec("pnpm", [
      "publish",
      tarball,
      "--registry",
      REGISTRY,
      "--tag",
      "latest",
      "--no-git-checks",
    ]),
  );
  yield* Console.log(`${spec} published`);
});

const command = Command.make(
  "fork-publish",
  {
    version: Argument.String("version").pipe(
      Argument.withDescription("Fork version to publish, <upstream version>-fork.N"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Rewrite and pack every package, print the plan, publish nothing"),
    ),
  },
  Effect.fn(function* ({ version, dryRun }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "../..");
    const destination = path.join(root, "release-packages");

    const packages = yield* publishablePackages(root, "packages");
    const upstream = yield* sharedVersion(packages);
    if (/^(.+)-fork\.\d+$/.exec(version)?.[1] !== upstream) {
      return yield* new InvalidForkVersion({
        message: `${version} is not ${upstream}-fork.N`,
        version,
      });
    }

    yield* fs.remove(destination, { recursive: true, force: true });
    yield* fs.makeDirectory(destination, { recursive: true });
    const planned = yield* Effect.forEach(packages, (pkg) => pack(root, destination, pkg, version));

    if (dryRun) {
      yield* Effect.forEach(planned, ({ spec }) => Console.log(spec));
      return yield* Console.log(`${planned.length} packages planned, nothing published`);
    }
    yield* Effect.forEach(planned, publish);
  }),
).pipe(Command.withDescription("Publish every package to GitHub Packages under the fork scope"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
