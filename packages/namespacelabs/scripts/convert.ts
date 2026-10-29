#!/usr/bin/env -S node --conditions=bun
/**
 * convert — turn Namespace's proto3 API (`buf.build/namespace/cloud`) into
 * Smithy 2.0 JSON models, one per proto service. Each unary RPC becomes
 * `POST /<package>.<Service>/<Method>` with a proto3 JSON body; streaming
 * RPCs are skipped.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { clearModels, writeModel } from "@distilled.cloud/dev/codegen/models";
import { finalizeConvert } from "@distilled.cloud/dev/codegen/patches";
import {
  convertProtoToSmithy,
  parseProto,
  type ProtoFile,
} from "@distilled.cloud/dev/codegen/proto";
import { resolveSpecPath } from "@distilled.cloud/dev/codegen/spec-path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, ".generated-specs");
const SPEC_DIR = "specs/spec-mirror-namespacelabs/specs/proto/namespace";

/** Slugs the package/service rule spells out too literally. */
const SLUG_ALIAS: Record<string, string> = {
  network_egress_policy: "egress",
  registry_container_registry: "registry",
  storage_artifacts: "artifacts",
  testing_test_results: "testing",
  private_sessions_user_sessions: "private_user_sessions",
};

const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

/**
 * `namespace.cloud.compute.v1beta` + `CommandService` → `compute_command`;
 * `namespace.private.devbox.v1beta` + `DevBoxService` → `private_devbox`.
 * The `cloud` tier and the version segment are dropped, and a service named
 * after its package collapses onto the package.
 */
const slugFor = (protoPackage: string, serviceName: string): string => {
  const [, tier, ...rest] = protoPackage.split(".");
  const area = rest
    .filter((segment) => !/^v\d/.test(segment) && segment !== "integrations")
    .join("_");
  const words = snake(serviceName.replace(/Service$/, "")).split("_");
  const compactArea = area.replace(/_/g, "");
  let prefix = "";
  let taken = 0;
  while (taken < words.length && prefix.length < compactArea.length) {
    prefix += words[taken];
    taken++;
  }
  const suffix = (prefix === compactArea ? words.slice(taken) : words).join("_");
  const raw = [tier === "cloud" ? undefined : tier, area, suffix || undefined]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("_");
  return SLUG_ALIAS[raw] ?? raw;
};

const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full.endsWith(".proto") ? [full] : [];
    })
    .sort();

const specDir = resolveSpecPath(ROOT, SPEC_DIR);
if (!fs.existsSync(specDir)) {
  throw new Error(
    `${specDir} not found — run \`pnpm specs:local namespacelabs\` (or \`pnpm run specs:fetch\` once the mirror exists)`,
  );
}

const files: ProtoFile[] = walk(specDir).map((file) =>
  parseProto(fs.readFileSync(file, "utf-8"), path.relative(specDir, file)),
);

clearModels(OUT_DIR);

let written = 0;
let totalOps = 0;
let totalStreaming = 0;
const slugs = new Map<string, string>();

for (const file of files) {
  for (const service of file.services) {
    const slug = slugFor(file.package, service.name);
    const taken = slugs.get(slug);
    if (taken !== undefined) {
      throw new Error(`${service.fullName} and ${taken} both map to the model slug "${slug}"`);
    }
    slugs.set(slug, service.fullName);

    const result = convertProtoToSmithy({
      files,
      namespace: `so.namespace.${slug.replace(/_/g, ".")}`,
      serviceName: service.name,
      serviceTitle: `Namespace ${service.name}`,
      serviceDocumentation:
        (service.documentation ? `${service.documentation}\n\n` : "") +
        `${service.fullName}. Each operation is POST /${service.fullName}/<Method> with a proto3 JSON body.`,
      protoService: service.fullName,
      skipStreaming: true,
      skipDeprecated: true,
    });
    totalStreaming += result.skippedStreaming;
    if (result.converted === 0) {
      console.log(`   ${slug}: only streaming RPCs, skipped`);
      continue;
    }
    writeModel(path.join(OUT_DIR, `${slug}.json`), result.model);
    written++;
    totalOps += result.converted;
    console.log(
      `   ${slug}: ${result.converted} ops, ${result.skippedStreaming} streaming skipped, ${result.shapeCount} shapes`,
    );
  }
}

console.log(
  `✅ ${written} Smithy models (${totalOps} operations` +
    (totalStreaming ? `, ${totalStreaming} streaming skipped` : "") +
    `) → ${OUT_DIR}`,
);

await finalizeConvert({ root: ROOT });
