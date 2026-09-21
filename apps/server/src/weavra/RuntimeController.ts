import {
  type ProjectId,
  type WeavraControlInput,
  type WeavraControlObservation,
  type WeavraControlResponse,
  type WeavraControlState,
  WeavraControlTransportError,
  WEAVRA_CONTROL_MAX_REQUEST_BYTES,
  WEAVRA_CONTROL_MAX_RESPONSE_BYTES,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
import { type ControlTransport, openControlTransport } from "./ControlTransport.ts";

export class RuntimeController extends Context.Service<
  RuntimeController,
  {
    readonly observe: (projectId: ProjectId) => Stream.Stream<WeavraControlObservation>;
    readonly command: (
      input: WeavraControlInput,
    ) => Effect.Effect<WeavraControlResponse, WeavraControlTransportError>;
  }
>()("t3/weavra/RuntimeController") {}
const initial: WeavraControlObservation = {
  status: "CONNECTING",
  state: null,
  capabilities: null,
  stale: true,
  observedAt: null,
  errorCode: null,
};
interface Entry {
  projectId: ProjectId;
  root: string;
  latest: WeavraControlObservation;
  changes: PubSub.PubSub<WeavraControlObservation>;
  scope: Scope.Closeable;
  bridge?: ControlTransport;
  refresh?: Effect.Effect<void, WeavraControlTransportError>;
  pending: number;
  stopped: boolean;
}
function consistent(response: WeavraControlResponse, previous: WeavraControlState | null): boolean {
  if (!response.success || response.data.kind !== "snapshot") return false;
  const state = response.data.state;
  const snapshot = state.snapshot;
  const run = snapshot.status.run;
  const approval = state.pendingApproval;
  return (
    response.ownerId === state.ownerId &&
    response.runId === (run?.runId ?? null) &&
    response.stateRevision === state.stateRevision &&
    (response.projectRevision ?? 0) === state.projectRevision &&
    state.nextRequestId.startsWith(`${state.ownerId}:`) &&
    snapshot.status.state !== "unavailable" &&
    snapshot.graphAvailable === (snapshot.graph !== null) &&
    (!snapshot.graph ||
      (snapshot.graph.runId === run?.runId &&
        snapshot.graph.stateRevision === state.stateRevision &&
        snapshot.graph.status === run.status)) &&
    (!snapshot.evidence ||
      (snapshot.evidence.runId === run?.runId &&
        snapshot.evidence.status === run.status &&
        snapshot.evidence.codeRevision === run.codeRevision)) &&
    (!state.preview ||
      (state.preview.ownerId === state.ownerId &&
        state.preview.projectRevision === state.projectRevision)) &&
    (!state.browserPreview ||
      (state.browserPreview.ownerId === state.ownerId &&
        state.browserPreview.projectRevision === state.projectRevision)) &&
    (!approval ||
      (approval.runId === run?.runId &&
        run.status === "WAITING_APPROVAL" &&
        approval.runId === state.ownedRunId &&
        state.busy &&
        approval.stateRevision === state.stateRevision &&
        approval.projectRevision === state.projectRevision)) &&
    (!previous ||
      (state.projectRevision >= previous.projectRevision &&
        (previous.snapshot.status.run?.runId !== run?.runId ||
          previous.stateRevision === null ||
          (state.stateRevision !== null && state.stateRevision >= previous.stateRevision))))
  );
}

/** Server lifetime owns execution transports. Subscriptions only observe and never release an owner. */
export const make = Effect.fn("weavra.runtimeController.make")(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  const serviceScope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const entries = new Map<string, Entry>();
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
  const projectRoot = Effect.fn("weavra.controlProjectRoot")(function* (projectId: ProjectId) {
    const project = yield* query
      .getProjectShellById(projectId)
      .pipe(
        Effect.mapError(() => new WeavraControlTransportError({ code: "PROJECT_UNAVAILABLE" })),
      );
    if (Option.isNone(project))
      return yield* new WeavraControlTransportError({ code: "PROJECT_UNAVAILABLE" });
    return yield* fs
      .realPath(project.value.workspaceRoot)
      .pipe(
        Effect.mapError(() => new WeavraControlTransportError({ code: "PROJECT_UNAVAILABLE" })),
      );
  });
  const validate = Effect.fn("weavra.validateControlProject")(function* (entry: Entry) {
    if ((yield* projectRoot(entry.projectId)) !== entry.root)
      return yield* new WeavraControlTransportError({ code: "PROJECT_CHANGED" });
  });
  const publish = Effect.fn("weavra.publishControl")(function* (
    entry: Entry,
    update: Partial<WeavraControlObservation>,
  ) {
    entry.latest = { ...entry.latest, ...update };
    yield* PubSub.publish(entry.changes, entry.latest);
  });
  const unavailable = Effect.fn("weavra.controlUnavailable")(function* (
    entry: Entry,
    error: WeavraControlTransportError,
  ) {
    yield* publish(entry, {
      status:
        error.code === "PROTOCOL_MISMATCH" || error.code === "INCOMPATIBLE_CAPABILITIES"
          ? "PROTOCOL_MISMATCH"
          : error.code === "TRANSPORT_CLOSED"
            ? "DISCONNECTED"
            : "ERROR",
      stale: true,
      errorCode: error.code,
      ...(error.code === "PROJECT_CHANGED" || error.code === "PROJECT_UNAVAILABLE"
        ? { state: null, observedAt: null }
        : {}),
    });
  });
  const connect = Effect.fn("weavra.connectControlOwner")(function* (entry: Entry) {
    if (!executable) return yield* new WeavraControlTransportError({ code: "NOT_INSTALLED" });
    const bridge = yield* openControlTransport(executable, entry.root, childEnv);
    let sequence = 0;
    const hello = yield* bridge.exchange({
      protocolVersion: 1,
      id: `t3-hello-${++sequence}`,
      type: "control.hello",
    });
    if (
      !hello.success ||
      hello.data.kind !== "capabilities" ||
      hello.ownerId !== hello.data.capabilities.ownerId ||
      hello.data.capabilities.maxRequestBytes !== WEAVRA_CONTROL_MAX_REQUEST_BYTES ||
      hello.data.capabilities.maxResponseBytes !== WEAVRA_CONTROL_MAX_RESPONSE_BYTES
    )
      return yield* new WeavraControlTransportError({ code: "INCOMPATIBLE_CAPABILITIES" });
    const capabilities = hello.data.capabilities;
    if (capabilities.readiness !== "READY") entry.stopped = true;
    yield* publish(entry, {
      capabilities,
      status: capabilities.readiness,
      stale: true,
      errorCode: null,
    });
    if (capabilities.readiness !== "READY") return;
    const refreshMutex = yield* Semaphore.make(1);
    const refresh = Effect.fn("weavra.refreshControlSnapshot")(function* () {
      yield* validate(entry);
      const response = yield* bridge.exchange({
        protocolVersion: 1,
        id: `t3-snapshot-${++sequence}`,
        type: "control.snapshot",
      });
      yield* validate(entry);
      if (
        response.ownerId !== capabilities.ownerId ||
        !consistent(response, entry.latest.state) ||
        !response.success ||
        response.data.kind !== "snapshot"
      )
        return yield* new WeavraControlTransportError({ code: "INVALID_PAYLOAD" });
      yield* publish(entry, {
        status: "CONNECTED",
        state: response.data.state,
        stale: false,
        observedAt: yield* Clock.currentTimeMillis,
        errorCode: null,
      });
    }, refreshMutex.withPermits(1));
    entry.bridge = bridge;
    entry.refresh = refresh();
    const poll = Effect.gen(function* () {
      while (true) {
        yield* refresh().pipe(
          Effect.catchIf(
            (error) => error.code === "REQUEST_TIMEOUT",
            (error) => unavailable(entry, error),
          ),
        );
        yield* Effect.sleep(Duration.seconds(2));
      }
    });
    return yield* Effect.raceFirst(poll, bridge.closed).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (entry.bridge === bridge) {
            delete entry.bridge;
            delete entry.refresh;
          }
        }),
      ),
    );
  });
  const run = Effect.fn("weavra.runControlOwner")(function* (entry: Entry) {
    let attempt = 0;
    while (true) {
      yield* validate(entry);
      yield* publish(entry, {
        status: attempt++ === 0 ? "CONNECTING" : "RECONNECTING",
        stale: true,
        errorCode: null,
      });
      const result = yield* connect(entry).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.scoped,
        Effect.result,
      );
      if (result._tag === "Success") return;
      const retryable =
        result.failure.code === "TRANSPORT_CLOSED" || result.failure.code === "SPAWN_FAILED";
      if (!retryable) entry.stopped = true;
      yield* unavailable(entry, result.failure);
      if (!retryable) return;
      // Only observation reconnects. Prior-epoch mutations are never resubmitted.
      yield* Effect.sleep(Duration.seconds(5));
    }
  });
  const acquire = Effect.fn("weavra.acquireControlOwner")(function* (projectId: ProjectId) {
    if (environment.T3_WEAVRA_CONTROL !== "1")
      return yield* new WeavraControlTransportError({ code: "INCOMPATIBLE_CAPABILITIES" });
    if (!executable) return yield* new WeavraControlTransportError({ code: "NOT_INSTALLED" });
    if (!path.isAbsolute(executable) || /[\r\n\0]/.test(executable))
      return yield* new WeavraControlTransportError({ code: "INVALID_EXECUTABLE" });
    const binary = yield* fs.stat(executable).pipe(Effect.option);
    if (Option.isNone(binary))
      return yield* new WeavraControlTransportError({ code: "NOT_INSTALLED" });
    if (binary.value.type !== "File" || (binary.value.mode & 0o111) === 0)
      return yield* new WeavraControlTransportError({ code: "INVALID_EXECUTABLE" });
    const root = yield* projectRoot(projectId);
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const existing = entries.get(root);
        if (existing && !existing.stopped) {
          if (existing.projectId !== projectId)
            return yield* new WeavraControlTransportError({ code: "PROJECT_CHANGED" });
          return existing;
        }
        if (existing) {
          yield* Scope.close(existing.scope, Exit.void);
          entries.delete(root);
        }
        if (entries.size >= 32) {
          const stopped = [...entries.values()].find((entry) => entry.stopped);
          if (stopped) {
            yield* Scope.close(stopped.scope, Exit.void);
            entries.delete(stopped.root);
          }
        }
        if (entries.size >= 32)
          return yield* new WeavraControlTransportError({ code: "STATE_UNAVAILABLE" });
        const scope = yield* Scope.fork(serviceScope);
        const entry: Entry = {
          projectId,
          root,
          scope,
          latest: initial,
          changes: yield* PubSub.sliding<WeavraControlObservation>(8),
          pending: 0,
          stopped: false,
        };
        entries.set(root, entry);
        yield* run(entry).pipe(
          Effect.catch((error) => {
            entry.stopped = true;
            return unavailable(entry, error);
          }),
          Effect.ensuring(
            Effect.sync(() => {
              entry.stopped = true;
            }),
          ),
          Effect.forkIn(scope),
        );
        return entry;
      }),
    );
  });
  return RuntimeController.of({
    observe: (projectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const result = yield* acquire(projectId).pipe(Effect.result);
          if (result._tag === "Failure")
            return Stream.make({
              ...initial,
              status: result.failure.code === "NOT_INSTALLED" ? "NOT_INSTALLED" : "ERROR",
              errorCode: result.failure.code,
            } satisfies WeavraControlObservation);
          const entry = result.success;
          const subscription = yield* subscribeBeforeSnapshotWithoutMutex(
            entry.changes,
            Effect.sync(() => entry.latest),
          );
          return Stream.concat(Stream.make(subscription.latest), subscription.changes);
        }),
      ),
    command: Effect.fn("weavra.controlCommand")(function* (input: WeavraControlInput) {
      if (environment.T3_WEAVRA_CONTROL !== "1")
        return yield* new WeavraControlTransportError({ code: "INCOMPATIBLE_CAPABILITIES" });
      const root = yield* projectRoot(input.projectId);
      const entry = entries.get(root);
      if (
        !entry ||
        entry.projectId !== input.projectId ||
        !entry.bridge ||
        !entry.refresh ||
        entry.latest.stale
      )
        return yield* new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" });
      if (entry.pending >= 8)
        return yield* new WeavraControlTransportError({ code: "STATE_UNAVAILABLE" });
      const bridge = entry.bridge;
      const refresh = entry.refresh;
      entry.pending++;
      const operation = Effect.gen(function* () {
        yield* validate(entry);
        const response = yield* bridge.exchange(input.request);
        yield* validate(entry);
        if (response.ownerId !== entry.latest.capabilities?.ownerId)
          return yield* new WeavraControlTransportError({ code: "INVALID_PAYLOAD" });
        if (response.success) {
          const request = input.request;
          const data = response.data;
          const valid =
            request.type === "workflow.prepare"
              ? data.kind === "prepared"
              : request.type === "browser.inspect"
                ? data.kind === "browser-state"
                : request.type === "browser.prepare"
                  ? data.kind === "browser-prepared" &&
                    data.preview.ownerId === request.ownerId &&
                    data.preview.projectRevision === request.expectedProjectRevision &&
                    data.preview.candidate.candidateId === request.registration.candidateId &&
                    data.preview.candidate.candidateDigest ===
                      request.registration.expectedCandidateDigest &&
                    data.preview.check.checkId === request.registration.checkId
                  : request.type === "browser.confirm"
                    ? data.kind === "browser-registered"
                    : data.kind === "accepted" &&
                      data.command === request.type &&
                      data.requestId === request.id;
          if (!valid) return yield* new WeavraControlTransportError({ code: "INVALID_PAYLOAD" });
        }
        yield* refresh.pipe(Effect.catch((error) => unavailable(entry, error)));
        return response;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.pending--;
          }),
        ),
      );
      // A disconnected caller stops waiting, not the server-owned command or Runtime execution.
      const fiber = yield* operation.pipe(Effect.forkIn(entry.scope));
      return yield* Fiber.join(fiber);
    }),
  });
});
export const layer = Layer.effect(RuntimeController, make());
