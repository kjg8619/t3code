import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type WeavraObservation,
  type WeavraSnapshotEnvelope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { expect } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentWeavraState, type WeavraViewState } from "./weavra.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("weavra-env"),
  label: "Fixture",
  httpBaseUrl: "http://localhost",
  wsBaseUrl: "ws://localhost",
});
function observed(
  projectRevision: number,
  stateRevision = projectRevision,
  runId = "run",
): WeavraObservation {
  const snapshot: WeavraSnapshotEnvelope = {
    protocolVersion: 1,
    runId,
    projectRevision,
    stateRevision,
    eventId: `${runId}:${stateRevision}`,
    timestamp: projectRevision,
    data: {
      status: {
        source: "durable-canonical-state",
        ownerObserved: false,
        state: "available",
        writerPresent: true,
        run: {
          runId,
          status: "RUNNING",
          phase: "IMPLEMENT",
          workflow: "STANDARD",
          risk: "R1",
          executionMode: "EDIT",
          codeRevision: 0,
          currentStep: { stepId: "implement", attempt: 1 },
          activeAgentCount: 1,
          taskContractDigest: null,
          createdAt: 1,
          updatedAt: projectRevision,
        },
      },
      graph: {
        runId,
        stateRevision,
        status: "RUNNING",
        nodes: [{ id: "implement:1", kind: "agent", status: "running", role: "Developer" }],
        edges: [],
      },
      graphAvailable: true,
      evidence: null,
      configuration: { source: "project-config-not-frozen-run-config", status: "missing" },
    },
  };
  return {
    status: "CONNECTED",
    snapshot,
    stale: false,
    runtimeVersion: "0.85.1",
    observedAt: projectRevision,
    errorCode: null,
  };
}
function session(
  events: Queue.Queue<WeavraObservation>,
  supported = true,
  onSubscribe = () => {},
): RpcSession {
  const client = {
    [WS_METHODS.weavraObserve]: () => {
      onSubscribe();
      return Stream.fromQueue(events);
    },
  } as unknown as WsRpcProtocolClient;
  return {
    client,
    initialConfig: Effect.succeed({
      environment: { capabilities: supported ? { weavraReadOnly: true } : {} },
    } as never),
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}
const setup = Effect.fnUntraced(function* (current: RpcSession) {
  const active = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.some(current));
  return EnvironmentSupervisor.of({
    target,
    session: active,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
});
function waitFor(
  state: SubscriptionRef.SubscriptionRef<WeavraViewState>,
  predicate: (value: WeavraViewState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

it.effect("does not send feature RPC to an environment without the capability", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WeavraObservation>();
    let calls = 0;
    const supervisor = yield* setup(
      session(events, false, () => {
        calls++;
      }),
    );
    const state = yield* makeEnvironmentWeavraState(ProjectId.make("project")).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    );
    expect(
      (yield* waitFor(state, (view) => view.support === "unsupported")).observation.stale,
    ).toBe(true);
    expect(calls).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect(
  "retains stale Run state through disconnect and replaces it only with a new-session canonical snapshot",
  () =>
    Effect.gen(function* () {
      const oldEvents = yield* Queue.unbounded<WeavraObservation>();
      const supervisor = yield* setup(session(oldEvents));
      const state = yield* makeEnvironmentWeavraState(ProjectId.make("project")).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
      );
      yield* Queue.offer(oldEvents, observed(10));
      yield* waitFor(state, (view) => !view.observation.stale);
      yield* SubscriptionRef.set(supervisor.session, Option.none());
      const disconnected = yield* waitFor(
        state,
        (view) => view.observation.status === "DISCONNECTED",
      );
      expect(disconnected.observation).toMatchObject({
        stale: true,
        snapshot: { projectRevision: 10, data: { status: { run: { status: "RUNNING" } } } },
      });
      const freshEvents = yield* Queue.unbounded<WeavraObservation>();
      yield* SubscriptionRef.set(supervisor.session, Option.some(session(freshEvents)));
      const reconnecting = yield* waitFor(
        state,
        (view) => view.support === "supported" && view.observation.status === "RECONNECTING",
      );
      expect(reconnecting.observation.snapshot?.projectRevision).toBe(10);
      expect(reconnecting.observation.stale).toBe(true);
      yield* Queue.offer(oldEvents, observed(999));
      yield* Queue.offer(freshEvents, {
        ...observed(0),
        status: "CONNECTING",
        snapshot: null,
        stale: true,
      });
      yield* waitFor(state, (view) => view.observation.status === "CONNECTING");
      expect((yield* SubscriptionRef.get(state)).observation.snapshot?.projectRevision).toBe(10);
      yield* Queue.offer(freshEvents, observed(11, 1, "new-run"));
      const connected = yield* waitFor(state, (view) => !view.observation.stale);
      expect(connected.observation.snapshot).toMatchObject({
        projectRevision: 11,
        stateRevision: 1,
        runId: "new-run",
        data: { evidence: null },
      });
    }).pipe(Effect.scoped),
);

it.effect("rejects a regressed first snapshot after the backend loses its subscription cache", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WeavraObservation>();
    const supervisor = yield* setup(session(events));
    const cache = { observation: observed(10) };
    const state = yield* makeEnvironmentWeavraState(ProjectId.make("project"), cache).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    );
    yield* Queue.offer(events, observed(9));
    const failed = yield* waitFor(
      state,
      (view) => view.observation.errorCode === "REVISION_REGRESSION",
    );
    expect(failed.observation.snapshot?.projectRevision).toBe(10);
    expect(failed.observation.stale).toBe(true);
    yield* Queue.offer(events, observed(11, 9));
    yield* waitFor(state, (view) => view.observation.errorCode === "REVISION_REGRESSION");
    yield* Queue.offer(events, observed(11, 11));
    expect(
      (yield* waitFor(state, (view) => !view.observation.stale)).observation.snapshot
        ?.stateRevision,
    ).toBe(11);
  }).pipe(Effect.scoped),
);

it.effect("clears old graph and evidence when the project scope is revoked", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WeavraObservation>();
    const supervisor = yield* setup(session(events));
    const state = yield* makeEnvironmentWeavraState(ProjectId.make("project"), {
      observation: observed(3),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
    yield* Queue.offer(events, {
      ...observed(3),
      status: "ERROR",
      errorCode: "PROJECT_CHANGED",
      snapshot: null,
      stale: true,
      observedAt: null,
    });
    const revoked = yield* waitFor(
      state,
      (view) => view.observation.errorCode === "PROJECT_CHANGED",
    );
    expect(revoked.observation.snapshot).toBeNull();
    expect(revoked.observation.observedAt).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect(
  "an obsolete scope cannot overwrite the successor's retained snapshot during teardown",
  () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<WeavraObservation>();
      const secondEvents = yield* Queue.unbounded<WeavraObservation>();
      const cache = { observation: observed(1) };
      const oldScope = yield* Scope.make();
      const firstSupervisor = yield* setup(session(firstEvents));
      yield* makeEnvironmentWeavraState(ProjectId.make("project"), cache).pipe(
        Effect.provideService(EnvironmentSupervisor, firstSupervisor),
        Scope.provide(oldScope),
      );
      const secondSupervisor = yield* setup(session(secondEvents));
      const current = yield* makeEnvironmentWeavraState(ProjectId.make("project"), cache).pipe(
        Effect.provideService(EnvironmentSupervisor, secondSupervisor),
      );
      yield* Queue.offer(secondEvents, observed(20));
      yield* waitFor(current, (view) => !view.observation.stale);
      yield* Scope.close(oldScope, Exit.void);
      expect(cache.observation.snapshot?.projectRevision).toBe(20);
      expect(cache.observation.stale).toBe(false);
    }).pipe(Effect.scoped),
);
