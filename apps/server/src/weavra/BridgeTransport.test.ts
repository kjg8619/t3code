import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type WeavraObservation, type WeavraSnapshotEnvelope } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { observeBridge } from "./BridgeTransport.ts";

const source = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.argv.slice(2).join('|') !== 'bridge|--stdio|--project-trusted') process.exit(41);
const mode = process.env.MODE;
let sequence = 0;
if (mode === 'ignore-term') writeFileSync('observer-pid', String(process.pid));
process.on('SIGTERM', () => {
 if (mode === 'ignore-term') { writeFileSync('observer-term-request', 'requested'); return; }
 writeFileSync('observer-closed', 'closed'); process.exit(0);
});
const capabilities = { readOnly:true,commands:['hello','capabilities','status','current-run','graph','evidence-summary','config-summary','snapshot'],events:'observations-only',reconnect:'fresh-canonical-snapshot-no-replay',authority:'Runtime/Kernel',maxRequestBytes:4096,maxResponseBytes:65536,runtimeVersion:'0.85.1',transport:'stdio',observationMode:'snapshots-only',readiness:mode==='not-setup'?'NOT_SETUP':mode==='invalid-config'?'CONFIG_INVALID':'READY' };
const data = {status:{source:'durable-canonical-state',ownerObserved:false,state:'missing',writerPresent:false,run:null},graph:null,graphAvailable:false,evidence:null,configuration:{source:'project-config-not-frozen-run-config',status:'missing'}};
for await (const line of createInterface({input:process.stdin})) {
 const request = JSON.parse(line);
 if (!['hello','snapshot'].includes(request.type)) process.exit(42);
 writeFileSync('request-receipt', request.type);
 if (mode==='exit') process.exit(0);
 if (mode==='eof') { process.stdout.end(); continue; }
 if (mode==='malformed') { process.stdout.write('{broken\\n'); continue; }
 if (mode==='oversized') { process.stdout.write('x'.repeat(65536)); continue; }
 if (mode==='invalid-utf8') { process.stdout.write(Buffer.from([255,10])); continue; }
 if (mode==='unknown-event') { process.stdout.write('{"protocolVersion":1,"type":"runtime_event","event":{"type":"InventedEvent"}}\\n'); continue; }
 if (mode==='timeout' && request.type==='snapshot') continue;
 const response = {protocolVersion:mode==='version'?2:1,runId:null,stateRevision:null,projectRevision:mode==='regression'&&request.type==='snapshot'?0:null,eventId:null,timestamp:1000,type:'response',id:mode==='wrong-id'?'unmatched':request.id,command:request.type,success:true,data:request.type==='hello'?capabilities:data};
 if (mode==='private-field') response.data.privateCredential='FAKE_SECRET_MUST_NOT_PASS';
 if (mode==='bad-authority') capabilities.readOnly=false;
 if (mode==='bad-snapshot' && request.type==='snapshot') response.runId='different-run';
 const output = JSON.stringify(response)+'\\n';
 if (mode==='split') { process.stdout.write(output.slice(0,13)); process.stdout.write(output.slice(13)); }
 else process.stdout.write(output);
 process.stderr.write('FAKE_SECRET_STDERR_NOT_FOR_CLIENT\\n');
 sequence++;
}
`;
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

it.effect("uses exact argv, persistent stdin, bounded split frames and scoped child cleanup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-transport-" });
    const executable = writeFakeCli({
      directory: cwd,
      name: "observer with spaces",
      source,
      env: { MODE: "split" },
    });
    const first = yield* Deferred.make<Partial<WeavraObservation>>();
    const second = yield* Deferred.make<Partial<WeavraObservation>>();
    let snapshots = 0;
    const fiber = yield* observeBridge(executable, cwd, env, null, (update) => {
      if (update.status !== "CONNECTED") return Effect.void;
      snapshots++;
      return Deferred.succeed(snapshots === 1 ? first : second, update).pipe(Effect.asVoid);
    }).pipe(Effect.scoped, Effect.forkScoped);
    const initial = yield* Deferred.await(first);
    expect(initial).toMatchObject({
      status: "CONNECTED",
      stale: false,
      snapshot: { data: { status: { ownerObserved: false, run: null } } },
    });
    yield* TestClock.adjust("2 seconds");
    expect((yield* Deferred.await(second)).snapshot).toEqual(initial.snapshot);
    yield* Fiber.interrupt(fiber);
    expect(yield* fs.readFileString(`${cwd}/observer-closed`)).toBe("closed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("bounds shutdown when an observer refuses SIGTERM", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-stubborn-observer-" });
    const executable = writeFakeCli({
      directory: cwd,
      name: "observer",
      source,
      env: { MODE: "ignore-term" },
    });
    const connected = yield* Deferred.make<void>();
    const fiber = yield* observeBridge(executable, cwd, env, null, (update) =>
      update.status === "CONNECTED"
        ? Deferred.succeed(connected, undefined).pipe(Effect.asVoid)
        : Effect.void,
    ).pipe(Effect.scoped, Effect.forkScoped);
    yield* Deferred.await(connected);
    const pid = Number(yield* fs.readFileString(`${cwd}/observer-pid`));
    yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"));
    expect(yield* fs.readFileString(`${cwd}/observer-term-request`)).toBe("requested");
    expect(yield* Effect.try(() => process.kill(pid, 0)).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { cause: { code: "ESRCH" } },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const [mode, code] of [
  ["version", "PROTOCOL_MISMATCH"],
  ["malformed", "INVALID_PAYLOAD"],
  ["oversized", "OVERSIZED_PAYLOAD"],
  ["invalid-utf8", "INVALID_PAYLOAD"],
  ["unknown-event", "INVALID_PAYLOAD"],
  ["wrong-id", "INVALID_PAYLOAD"],
  ["private-field", "INVALID_PAYLOAD"],
  ["bad-authority", "INVALID_PAYLOAD"],
  ["bad-snapshot", "INVALID_PAYLOAD"],
  ["exit", "TRANSPORT_CLOSED"],
  ["eof", "TRANSPORT_CLOSED"],
  ["regression", "REVISION_REGRESSION"],
] as const) {
  it.effect(`fails closed on ${mode} without publishing a fresh snapshot`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-boundary-" });
      const executable = writeFakeCli({
        directory: cwd,
        name: "observer",
        source,
        env: { MODE: mode },
      });
      const updates: Partial<WeavraObservation>[] = [];
      const previous =
        mode === "regression"
          ? ({
              protocolVersion: 1,
              runId: null,
              stateRevision: null,
              projectRevision: 1,
              eventId: null,
              timestamp: 0,
              data: {
                status: {
                  source: "durable-canonical-state",
                  ownerObserved: false,
                  state: "missing",
                  writerPresent: false,
                  run: null,
                },
                graph: null,
                graphAvailable: false,
                evidence: null,
                configuration: {
                  source: "project-config-not-frozen-run-config",
                  status: "missing",
                },
              },
            } satisfies WeavraSnapshotEnvelope)
          : null;
      const result = yield* observeBridge(executable, cwd, env, previous, (update) =>
        Effect.sync(() => {
          updates.push(update);
        }),
      ).pipe(Effect.scoped, Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code } });
      expect(updates.some((update) => update.stale === false)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("times out a pending read and releases only its owned child", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-timeout-" });
    const executable = writeFakeCli({
      directory: cwd,
      name: "observer",
      source,
      env: { MODE: "timeout" },
    });
    const ready = yield* Deferred.make<void>();
    const fiber = yield* observeBridge(executable, cwd, env, null, (update) =>
      update.status === "READY"
        ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
        : Effect.void,
    ).pipe(Effect.scoped, Effect.result, Effect.forkScoped);
    yield* Deferred.await(ready);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { code: "REQUEST_TIMEOUT" },
    });
    expect(yield* fs.readFileString(`${cwd}/observer-closed`)).toBe("closed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const [mode, status] of [
  ["not-setup", "NOT_SETUP"],
  ["invalid-config", "CONFIG_INVALID"],
] as const) {
  it.effect(`reports ${status} without attempting a snapshot or setup`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-readiness-" });
      const executable = writeFakeCli({
        directory: cwd,
        name: "observer",
        source,
        env: { MODE: mode },
      });
      const updates: Partial<WeavraObservation>[] = [];
      yield* observeBridge(executable, cwd, env, null, (update) =>
        Effect.sync(() => {
          updates.push(update);
        }),
      ).pipe(Effect.scoped);
      expect(updates).toEqual([expect.objectContaining({ status, stale: true })]);
      expect(yield* fs.readFileString(`${cwd}/request-receipt`)).toBe("hello");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
