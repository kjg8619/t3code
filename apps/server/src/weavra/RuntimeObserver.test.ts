import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ProjectId,
  type OrchestrationProjectShell,
  type WeavraObservation,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { make } from "./RuntimeObserver.ts";

const projectId = ProjectId.make("fixture-project");
const source = `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const launch = existsSync('launch-count') ? Number(readFileSync('launch-count','utf8'))+1 : 1;
writeFileSync('launch-count', String(launch));
process.on('SIGTERM', () => { writeFileSync('closed', String(launch)); process.exit(0); });
let snapshots = 0;
for await(const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 if(request.type==='snapshot' && ++snapshots===2 && launch===1 && process.env.MODE==='reconnect') process.exit(0);
 const data=request.type==='hello'?{readOnly:true,commands:['hello','capabilities','status','current-run','graph','evidence-summary','config-summary','snapshot'],events:'observations-only',reconnect:'fresh-canonical-snapshot-no-replay',authority:'Runtime/Kernel',maxRequestBytes:4096,maxResponseBytes:65536,runtimeVersion:'0.85.1',transport:'stdio',observationMode:'snapshots-only',readiness:'READY'}:{status:{source:'durable-canonical-state',ownerObserved:false,state:'missing',writerPresent:false,run:null},graph:null,graphAvailable:false,evidence:null,configuration:{source:'project-config-not-frozen-run-config',status:'missing'}};
 process.stdout.write(JSON.stringify({protocolVersion:1,runId:null,stateRevision:null,projectRevision:request.type==='snapshot'?launch:null,eventId:null,timestamp:launch,type:'response',id:request.id,command:request.type,success:true,data})+'\\n');
}
`;
function project(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: projectId,
    title: "Fixture",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}
function next(queue: Queue.Queue<WeavraObservation>, status: WeavraObservation["status"]) {
  return Stream.fromQueue(queue).pipe(
    Stream.filter((observation) => observation.status === status),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}
for (const [configuration, expected] of [
  ["absent", "NOT_INSTALLED"],
  ["missing-file", "NOT_INSTALLED"],
  ["relative", "CONFIG_INVALID"],
  ["non-executable", "CONFIG_INVALID"],
] as const) {
  it.effect(`reports ${configuration} without spawning or creating Runtime state`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-availability-" });
      const binary = `${root}/unavailable`;
      if (configuration === "non-executable") yield* fs.writeFileString(binary, "not executable");
      const environment =
        configuration === "absent"
          ? {}
          : { T3_WEAVRA_EXECUTABLE: configuration === "relative" ? "weavra" : binary };
      const observer = yield* make().pipe(
        Effect.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: () => Effect.succeedSome(project(root)),
          }),
        ),
        Effect.provideService(HostProcessEnvironment, environment),
      );
      const observation = yield* observer.observe(projectId).pipe(
        Stream.filter((value) => value.status === expected),
        Stream.runHead,
      );
      expect(Option.getOrThrow(observation)).toMatchObject({
        status: expected,
        stale: true,
        snapshot: null,
      });
      expect(yield* fs.exists(`${root}/.ai`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("shares one child across consumers and reconnects with a fresh snapshot after exit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-reconnect-" });
    const executable = writeFakeCli({
      directory: root,
      name: "observer",
      source,
      env: { MODE: "reconnect" },
    });
    const observer = yield* make().pipe(
      Effect.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeedSome(project(root)),
        }),
      ),
      Effect.provideService(HostProcessEnvironment, {
        PATH: process.env.PATH,
        T3_WEAVRA_EXECUTABLE: executable,
      }),
    );
    const first = yield* Queue.unbounded<WeavraObservation>();
    const second = yield* Queue.unbounded<WeavraObservation>();
    const consumerA = yield* observer.observe(projectId).pipe(
      Stream.runForEach((value) => Queue.offer(first, value)),
      Effect.forkScoped,
    );
    expect((yield* next(first, "CONNECTED")).snapshot?.projectRevision).toBe(1);
    const consumerB = yield* observer.observe(projectId).pipe(
      Stream.runForEach((value) => Queue.offer(second, value)),
      Effect.forkScoped,
    );
    yield* next(second, "CONNECTED");
    yield* Fiber.interrupt(consumerA);
    expect(yield* fs.readFileString(`${root}/launch-count`)).toBe("1");
    yield* TestClock.adjust("2 seconds");
    const disconnected = yield* next(second, "DISCONNECTED");
    expect(disconnected).toMatchObject({ stale: true, snapshot: { projectRevision: 1 } });
    yield* TestClock.adjust("5 seconds");
    const reconnected = yield* next(second, "CONNECTED");
    expect(reconnected).toMatchObject({ stale: false, snapshot: { projectRevision: 2 } });
    expect(yield* fs.readFileString(`${root}/launch-count`)).toBe("2");
    yield* Fiber.interrupt(consumerB);
    expect(yield* fs.readFileString(`${root}/closed`)).toBe("2");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "revokes a healthy old-root observer and gives a new checkout an independent canonical snapshot",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const firstRoot = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-root-a-" });
      const secondRoot = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-root-b-" });
      const executable = writeFakeCli({ directory: firstRoot, name: "observer", source });
      let selected: OrchestrationProjectShell | undefined = project(firstRoot);
      const observer = yield* make().pipe(
        Effect.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: () => Effect.sync(() => Option.fromUndefinedOr(selected)),
          }),
        ),
        Effect.provideService(HostProcessEnvironment, {
          PATH: process.env.PATH,
          T3_WEAVRA_EXECUTABLE: executable,
        }),
      );
      const old = yield* Queue.unbounded<WeavraObservation>();
      yield* observer.observe(projectId).pipe(
        Stream.runForEach((value) => Queue.offer(old, value)),
        Effect.forkScoped,
      );
      yield* next(old, "CONNECTED");
      selected = project(secondRoot);
      yield* TestClock.adjust("2 seconds");
      expect(yield* next(old, "ERROR")).toMatchObject({
        snapshot: null,
        stale: true,
        errorCode: "PROJECT_CHANGED",
      });
      const current = yield* Queue.unbounded<WeavraObservation>();
      yield* observer.observe(projectId).pipe(
        Stream.runForEach((value) => Queue.offer(current, value)),
        Effect.forkScoped,
      );
      expect((yield* next(current, "CONNECTED")).stale).toBe(false);
      expect(yield* fs.readFileString(`${secondRoot}/launch-count`)).toBe("1");
      selected = undefined;
      yield* TestClock.adjust("2 seconds");
      expect(yield* next(current, "ERROR")).toMatchObject({
        snapshot: null,
        errorCode: "PROJECT_UNAVAILABLE",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
