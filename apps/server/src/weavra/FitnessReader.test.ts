import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, type WeavraFitnessHistory, type WeavraFitnessInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { readFitness } from "./FitnessReader.ts";

const projectId = ProjectId.make("fitness-project");
const digest = `sha256:${"a".repeat(64)}`;
const legacyRun: WeavraFitnessHistory["runs"][number] = {
  id: "11111111-1111-4111-8111-111111111111",
  target: {
    provider: "sample",
    model: "sample-model",
    api: "sample-api",
    endpointIdentity: digest,
    harnessRevision: "a".repeat(40),
    toolSchemaRevision: digest,
    promptRuntimeRevision: digest,
    configurationDigest: digest,
  },
  status: "COMPLETED",
  kind: "ACTUAL",
  correctness: { executed: 1, oraclePass: 1, oracleFail: 0, invalid: 0, falseCompletion: 0 },
  contract: {
    scopeViolations: 0,
    forbiddenMutationAttempts: 0,
    strictReceiptRejections: 0,
    handoffRejections: 0,
    reviewRejections: 0,
  },
  tools: {
    calls: 1,
    invalidCalls: 0,
    retries: 0,
    runtimeRead: 1,
    runtimeEdit: 0,
    runtimeWrite: 0,
    lsp: 0,
  },
  reliability: {
    providerErrors: 0,
    authErrors: 0,
    transportErrors: null,
    timeouts: 0,
    repairCount: 0,
    reviewerRevisionCount: 0,
  },
  efficiency: {
    workerInvocations: 1,
    modelTurns: 1,
    tokens: 20,
    knownTokens: 20,
    latencyMs: 100,
    contextBytes: 100,
    costUsd: null,
  },
  corpusRevision: "weavra-fitness-1",
  corpusDigest: digest,
  startedAt: 1,
  completedAt: 101,
  resultDigest: digest,
};
const partialRun: WeavraFitnessHistory["runs"][number] = {
  ...legacyRun,
  id: "22222222-2222-4222-8222-222222222222",
  corpusRevision: "weavra-fitness-3",
  status: "BUDGET_EXHAUSTED",
  calibration: "CALIBRATION_READY",
  evaluation: "EVALUATION_PARTIAL",
  stopReasons: ["USAGE_UNKNOWN"],
  correctness: { executed: 3, oraclePass: 1, oracleFail: 2, invalid: 0, falseCompletion: 1 },
  efficiency: {
    ...legacyRun.efficiency,
    workerInvocations: 3,
    modelTurns: 3,
    tokens: null,
    knownTokens: 40,
    latencyMs: 600,
  },
  completedAt: 601,
  fixtureResults: [
    {
      fixtureId: "F01",
      terminalStatus: "COMPLETED",
      oracle: "PASS",
      falseCompletion: false,
      taskContractAdherence: true,
      usageState: "KNOWN",
      integrity: { state: "READY", reasons: [] },
      latencyMs: 100,
    },
    {
      fixtureId: "F02",
      terminalStatus: "COMPLETED",
      oracle: "FAIL",
      falseCompletion: true,
      taskContractAdherence: false,
      usageState: "KNOWN",
      integrity: { state: "READY", reasons: [] },
      latencyMs: 200,
    },
    {
      fixtureId: "F03",
      terminalStatus: "CANCELLED",
      oracle: "FAIL",
      falseCompletion: null,
      taskContractAdherence: null,
      usageState: "UNKNOWN",
      integrity: { state: "INVALID", reasons: ["USAGE_UNKNOWN"] },
      latencyMs: 300,
    },
  ],
};
const source = `
if (process.argv.slice(2).join('|') !== 'fitness|list|--json') process.exit(41);
const data = {schemaVersion:1,corpusRevision:'weavra-fitness-1',corpusDigest:'sha256:'+'a'.repeat(64),fixtures:[],runs:[]};
if (process.env.MODE === 'mixed') {
  data.corpusRevision = 'weavra-fitness-3';
  data.runs = ${JSON.stringify([legacyRun, partialRun])};
}
if (process.env.MODE === 'secret') data.rawResponse = 'SECRET_MUST_NOT_PASS';
if (process.env.MODE === 'version') data.schemaVersion=2;
if (process.env.MODE === 'oversized') { process.stdout.write('x'.repeat(262145)); } else process.stdout.write(JSON.stringify(data)+'\\n');
process.stderr.write('PRIVATE_PROVIDER_ERROR_MUST_NOT_PASS');
if (process.env.MODE === 'exit') process.exitCode=1;
`;
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
it.effect(
  "reads bounded typed history through a fixed read-only command without forwarding stderr",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "fitness-reader-" });
      const executable = writeFakeCli({ directory: cwd, name: "fitness reader", source });
      const result = yield* readFitness(executable, cwd, env, { projectId, command: "list" });
      expect(result).toMatchObject({ command: "list", data: { schemaVersion: 1, runs: [] } });
      expect(NodeUtil.inspect(result)).not.toContain("PRIVATE_PROVIDER_ERROR");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect(
  "preserves mixed fixture outcomes and partial evidence alongside unchanged legacy records",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "fitness-reader-" });
      const executable = writeFakeCli({
        directory: cwd,
        name: "fitness reader",
        source,
        env: { MODE: "mixed" },
      });
      const result = yield* readFitness(executable, cwd, env, { projectId, command: "list" });
      expect(result).toEqual({
        command: "list",
        data: {
          schemaVersion: 1,
          corpusRevision: "weavra-fitness-3",
          corpusDigest: digest,
          fixtures: [],
          runs: [legacyRun, partialRun],
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
for (const mode of ["secret", "version", "oversized", "exit"])
  it.effect(`rejects ${mode} output without leaking private diagnostics`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "fitness-reader-" });
      const executable = writeFakeCli({
        directory: cwd,
        name: "fitness",
        source,
        env: { MODE: mode },
      });
      const result = yield* readFitness(executable, cwd, env, { projectId, command: "list" }).pipe(
        Effect.result,
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: mode === "exit" ? "UNAVAILABLE" : "INVALID_PAYLOAD" },
      });
      expect(NodeUtil.inspect(result)).not.toContain("PRIVATE_PROVIDER_ERROR");
      expect(NodeUtil.inspect(result)).not.toContain("SECRET_MUST_NOT_PASS");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
it.effect(
  "refuses execution verbs, path traversal and injected argv before launching a process",
  () =>
    Effect.gen(function* () {
      for (const input of [
        { projectId, command: "run", target: "provider/model" },
        { projectId, command: "compare", left: "../auth", right: "anything" },
        { projectId, command: "list", argv: ["--allow-paid"], storeDir: "/private" },
      ]) {
        const result = yield* readFitness(
          "/never-spawn",
          "/",
          env,
          input as WeavraFitnessInput,
        ).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_PAYLOAD" } });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
