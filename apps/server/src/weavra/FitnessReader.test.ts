import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, type WeavraFitnessInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { readFitness } from "./FitnessReader.ts";

const projectId = ProjectId.make("fitness-project");
const source = `
if (process.argv.slice(2).join('|') !== 'fitness|list|--json') process.exit(41);
const data = {schemaVersion:1,corpusRevision:'weavra-fitness-1',corpusDigest:'sha256:'+'a'.repeat(64),fixtures:[],runs:[]};
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
