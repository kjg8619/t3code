import {
  type ProjectId,
  type WeavraObservation,
  type WeavraFitnessInput,
  type WeavraFitnessResponse,
  WeavraFitnessError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";
import { BridgeFailure, observeBridge } from "./BridgeTransport.ts";
import { readFitness } from "./FitnessReader.ts";

export class RuntimeObserver extends Context.Service<
  RuntimeObserver,
  {
    readonly observe: (projectId: ProjectId) => Stream.Stream<WeavraObservation>;
    readonly fitness: (
      input: WeavraFitnessInput,
    ) => Effect.Effect<WeavraFitnessResponse, WeavraFitnessError>;
  }
>()("t3/weavra/RuntimeObserver") {}

const initial: WeavraObservation = {
  status: "CONNECTING",
  snapshot: null,
  stale: true,
  runtimeVersion: null,
  observedAt: null,
  errorCode: null,
};
interface ObservationEntry {
  count: number;
  latest: WeavraObservation;
  scope: Scope.Closeable;
  changes: PubSub.PubSub<WeavraObservation>;
}

/** @public Service construction follows the environment-owned Effect service API. */
export const make = Effect.fn("weavra.runtimeObserver.make")(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  const serviceScope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const entries = new Map<string, ObservationEntry>();
  // Trusted server startup configuration only. Never accepts executable/cwd/argv/env from RPC.
  const executable = environment.T3_WEAVRA_EXECUTABLE;
  const childEnv: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "WEAVRA_HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SystemRoot",
  ] as const) {
    const value = environment[key];
    if (value !== undefined) childEnv[key] = value;
  }
  const projectRoot = Effect.fn("weavra.projectRoot")(function* (projectId: ProjectId) {
    const project = yield* query
      .getProjectShellById(projectId)
      .pipe(Effect.mapError(() => new BridgeFailure({ code: "PROJECT_UNAVAILABLE" })));
    if (Option.isNone(project)) return yield* new BridgeFailure({ code: "PROJECT_UNAVAILABLE" });
    return yield* fs
      .realPath(project.value.workspaceRoot)
      .pipe(Effect.mapError(() => new BridgeFailure({ code: "PROJECT_UNAVAILABLE" })));
  });
  const run = Effect.fn("weavra.observeProject")(function* (
    projectId: ProjectId,
    root: string,
    entry: ObservationEntry,
  ) {
    const publish = (update: Partial<WeavraObservation>) =>
      Effect.gen(function* () {
        entry.latest = { ...entry.latest, ...update };
        yield* PubSub.publish(entry.changes, entry.latest);
      });
    if (!executable) {
      yield* publish({ status: "NOT_INSTALLED", errorCode: "NOT_INSTALLED" });
      return;
    }
    if (!path.isAbsolute(executable) || /[\r\n\0]/.test(executable)) {
      yield* publish({ status: "CONFIG_INVALID", errorCode: "INVALID_EXECUTABLE" });
      return;
    }
    const exists = yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* publish({ status: "NOT_INSTALLED", errorCode: "NOT_INSTALLED" });
      return;
    }
    const binary = yield* fs.stat(executable).pipe(Effect.option);
    if (
      Option.isNone(binary) ||
      binary.value.type !== "File" ||
      (binary.value.mode & 0o111) === 0
    ) {
      yield* publish({ status: "CONFIG_INVALID", errorCode: "INVALID_EXECUTABLE" });
      return;
    }
    const validateProject = projectRoot(projectId).pipe(
      Effect.flatMap((currentRoot) =>
        currentRoot === root
          ? Effect.void
          : Effect.fail(new BridgeFailure({ code: "PROJECT_CHANGED" })),
      ),
    );
    let attempt = 0;
    while (true) {
      yield* publish({
        status: attempt++ === 0 ? "CONNECTING" : "RECONNECTING",
        stale: true,
        errorCode: null,
      });
      const result = yield* observeBridge(
        executable,
        root,
        childEnv,
        entry.latest.snapshot,
        publish,
        validateProject,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.scoped,
        Effect.result,
      );
      if (result._tag === "Success") return; // Local readiness failure is explicit, not an install/setup retry.
      const failure: BridgeFailure = result.failure;
      yield* publish({
        status:
          failure.code === "PROTOCOL_MISMATCH" || failure.code === "INCOMPATIBLE_CAPABILITIES"
            ? "PROTOCOL_MISMATCH"
            : failure.code === "TRANSPORT_CLOSED"
              ? "DISCONNECTED"
              : "ERROR",
        stale: true,
        errorCode: failure.code,
        ...(failure.code === "PROJECT_CHANGED" || failure.code === "PROJECT_UNAVAILABLE"
          ? { snapshot: null, observedAt: null }
          : {}),
      });
      if (!["TRANSPORT_CLOSED", "SPAWN_FAILED", "REQUEST_TIMEOUT"].includes(failure.code)) return;
      yield* Effect.sleep(Duration.seconds(5));
    }
  });
  const acquire = Effect.fn("weavra.acquireObservation")(function* (
    key: string,
    projectId: ProjectId,
    root: string,
  ) {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        let entry = entries.get(key);
        if (!entry) {
          const scope = yield* Scope.fork(serviceScope);
          entry = {
            count: 0,
            latest: initial,
            scope,
            changes: yield* PubSub.sliding<WeavraObservation>(8),
          };
          entries.set(key, entry);
          yield* run(projectId, root, entry).pipe(Effect.forkIn(scope));
        }
        entry.count++;
        return entry;
      }),
    );
  });
  return RuntimeObserver.of({
    fitness: (input) =>
      Effect.gen(function* () {
        if (!executable || !path.isAbsolute(executable) || /[\r\n\0]/.test(executable))
          return yield* new WeavraFitnessError({ code: "UNAVAILABLE" });
        const root = yield* projectRoot(input.projectId).pipe(
          Effect.mapError(() => new WeavraFitnessError({ code: "UNAVAILABLE" })),
        );
        const result = yield* readFitness(executable, root, childEnv, input).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeoutOrElse({
            duration: Duration.seconds(20),
            orElse: () => Effect.fail(new WeavraFitnessError({ code: "UNAVAILABLE" })),
          }),
          Effect.scoped,
        );
        const after = yield* projectRoot(input.projectId).pipe(
          Effect.mapError(() => new WeavraFitnessError({ code: "PROJECT_CHANGED" })),
        );
        if (after !== root) return yield* new WeavraFitnessError({ code: "PROJECT_CHANGED" });
        return result;
      }),
    observe: (projectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const root = yield* projectRoot(projectId).pipe(Effect.option);
          if (Option.isNone(root))
            return Stream.make({
              ...initial,
              status: "ERROR",
              errorCode: "PROJECT_UNAVAILABLE",
            } satisfies WeavraObservation);
          const key = `${projectId.length}:${projectId}${root.value}`;
          const entry = yield* Effect.acquireRelease(acquire(key, projectId, root.value), (owned) =>
            mutex.withPermits(1)(
              Effect.gen(function* () {
                owned.count--;
                if (owned.count === 0) {
                  entries.delete(key);
                  yield* Scope.close(owned.scope, Exit.void);
                  yield* PubSub.shutdown(owned.changes);
                }
              }),
            ),
          );
          const subscription = yield* subscribeBeforeSnapshotWithoutMutex(
            entry.changes,
            Effect.sync(() => entry.latest),
          );
          return Stream.concat(Stream.make(subscription.latest), subscription.changes);
        }),
      ),
  });
});
export const layer = Layer.effect(RuntimeObserver, make());
