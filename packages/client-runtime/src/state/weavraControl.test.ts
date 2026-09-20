import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  WEAVRA_CONTROL_COMMANDS,
  WeavraControlTransportError,
  WS_METHODS,
  type WeavraControlInput,
  type WeavraControlObservation,
  type WeavraControlObserveInput,
  type WeavraControlResponse,
  type WeavraControlState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createEnvironmentWeavraControlCommand,
  createEnvironmentWeavraControlStateAtoms,
  makeEnvironmentWeavraControlState,
  type WeavraControlViewState,
} from "./weavraControl.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("weavra-control-env"),
  label: "Fixture",
  httpBaseUrl: "http://localhost",
  wsBaseUrl: "ws://localhost",
});
const projectId = ProjectId.make("project");
const digest = `sha256:${"a".repeat(64)}`;

function canonicalState(
  projectRevision: number,
  stateRevision: number | null = projectRevision,
  runId = "run",
  ownerId = "owner",
): WeavraControlState {
  return {
    ownerId,
    nextRequestId: `${ownerId}:${projectRevision + 1}`,
    projectRevision,
    stateRevision,
    ownedRunId: runId,
    busy: true,
    cancelling: false,
    startFailure: null,
    preview: {
      previewId: "preview",
      previewDigest: digest,
      ownerId,
      projectRevision,
      expiresAt: 10000,
      goal: "Implement the feature",
      workflow: "STANDARD",
      executionMode: "EDIT",
      risk: "R3",
      allowedPaths: ["src/obsolete.ts"],
      checks: [],
      acceptanceCriteria: [],
      taskContractDigest: digest,
      recipe: null,
      configuration: {
        mutationMode: "strict",
        verifierTrustMode: "strict",
        verifierSandboxMode: "required",
        contextPackMode: "bounded",
        verificationRepairMode: "disabled",
        lspEnabled: false,
      },
    },
    pendingApproval: {
      approvalId: "approval",
      runId,
      stateRevision: stateRevision ?? 0,
      projectRevision,
      risk: "R3",
      operation: "delete-file",
      role: "Developer",
      step: { stepId: "implement", attempt: 1 },
      path: "src/obsolete.ts",
      bytes: 20,
      preconditionDigest: "b".repeat(64),
      expiresAt: 10000,
      explanation: "Remove obsolete implementation",
    },
    snapshot: {
      status: {
        source: "durable-canonical-state",
        ownerObserved: false,
        state: "available",
        writerPresent: true,
        run: {
          runId,
          status: "WAITING_APPROVAL",
          phase: "IMPLEMENT",
          workflow: "STANDARD",
          risk: "R3",
          executionMode: "EDIT",
          codeRevision: 0,
          currentStep: { stepId: "implement", attempt: 1 },
          activeAgentCount: 0,
          taskContractDigest: digest,
          createdAt: 1,
          updatedAt: projectRevision,
        },
      },
      graph: {
        runId,
        stateRevision: stateRevision ?? 0,
        status: "WAITING_APPROVAL",
        nodes: [{ id: "implement:1", kind: "agent", status: "blocked", role: "Developer" }],
        edges: [],
      },
      graphAvailable: true,
      evidence: null,
      configuration: { source: "project-config-not-frozen-run-config", status: "missing" },
    },
  };
}

function observed(
  projectRevision: number,
  stateRevision: number | null = projectRevision,
  runId = "run",
  ownerId = "owner",
): WeavraControlObservation {
  return {
    status: "CONNECTED",
    state: canonicalState(projectRevision, stateRevision, runId, ownerId),
    capabilities: {
      authority: "Runtime/Kernel",
      control: "workflow-control-v1",
      ownerId,
      commands: WEAVRA_CONTROL_COMMANDS,
      maxRequestBytes: 32768,
      maxResponseBytes: 65536,
      resultLimit: 100,
      previewTtlMs: 10000,
      runtimeVersion: "0.85.1",
      readiness: "READY",
      recipes: [],
    },
    stale: false,
    observedAt: projectRevision,
    errorCode: null,
  };
}

type ObservationEvent = Effect.Effect<WeavraControlObservation, WeavraControlTransportError>;
type ObservationSubscription = {
  input: WeavraControlObserveInput;
  events: Queue.Queue<ObservationEvent>;
};
const makeSession = Effect.fnUntraced(function* (
  capabilities: { weavraControl?: boolean } = { weavraControl: true },
) {
  const subscriptions = yield* Queue.unbounded<ObservationSubscription>();
  const requests = yield* Queue.unbounded<{
    input: WeavraControlInput;
    reply: Deferred.Deferred<WeavraControlResponse, WeavraControlTransportError>;
  }>();
  const sent: WeavraControlInput[] = [];
  const client = {
    [WS_METHODS.weavraControlObserve]: (input: WeavraControlObserveInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<ObservationEvent>();
          yield* Queue.offer(subscriptions, { input, events });
          return Stream.fromQueue(events).pipe(Stream.mapEffect((event) => event));
        }),
      ),
    [WS_METHODS.weavraControl]: (input: WeavraControlInput) =>
      Effect.gen(function* () {
        sent.push(input);
        const reply = yield* Deferred.make<WeavraControlResponse, WeavraControlTransportError>();
        yield* Queue.offer(requests, { input, reply });
        return yield* Deferred.await(reply);
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ environment: { capabilities } } as never),
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return { session, subscriptions, requests, sent };
});
const setup = Effect.fnUntraced(function* (current: RpcSession) {
  return EnvironmentSupervisor.of({
    target,
    session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.some(current)),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
});
function waitFor(
  state: SubscriptionRef.SubscriptionRef<WeavraControlViewState>,
  predicate: (value: WeavraControlViewState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}
const makeRuntime = Effect.fnUntraced(function* (supervisor: EnvironmentSupervisor["Service"]) {
  const run: EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_environmentId, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run,
      followStream,
      stateChanges: () => SubscriptionRef.changes(supervisor.state),
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return {
    registry,
    command: createEnvironmentWeavraControlCommand(runtime),
    atoms: createEnvironmentWeavraControlStateAtoms(runtime),
  };
});
function waitForAtom<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  predicate: (value: A) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(AsyncResult.isSuccess),
    Stream.map((result) => result.value),
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}
const cancelInput: WeavraControlInput = {
  projectId,
  request: {
    protocolVersion: 1,
    id: "owner:11",
    ownerId: "owner",
    expectedProjectRevision: 10,
    type: "workflow.cancel",
    runId: "run",
    expectedStateRevision: 10,
  },
};
function accepted(input: WeavraControlInput): WeavraControlResponse {
  const command = input.request.type;
  if (command === "workflow.prepare") throw new Error("Prepare is not an accepted acknowledgement");
  return {
    protocolVersion: 1,
    type: "control_response",
    id: input.request.id,
    command,
    ownerId: input.request.ownerId,
    runId: "run",
    projectRevision: 11,
    stateRevision: 11,
    eventId: "run:11",
    timestamp: 11,
    success: true,
    data: { kind: "accepted", command, requestId: input.request.id, runId: "run" },
  };
}

for (const capabilities of [{}, { weavraControl: false }]) {
  it.effect(
    `never opens a control stream without explicit opt-in (${JSON.stringify(capabilities)})`,
    () =>
      Effect.gen(function* () {
        const remote = yield* makeSession(capabilities);
        const supervisor = yield* setup(remote.session);
        const state = yield* makeEnvironmentWeavraControlState(projectId).pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
        );
        const unsupported = yield* waitFor(state, (view) => view.support === "unsupported");
        expect(unsupported.observation).toMatchObject({ state: null, stale: true });
        expect(yield* Queue.size(remote.subscriptions)).toBe(0);
      }).pipe(Effect.scoped),
  );
}

it.effect(
  "opens controlObserve with only the project and becomes fresh only on canonical CONNECTED state",
  () =>
    Effect.gen(function* () {
      const remote = yield* makeSession();
      const supervisor = yield* setup(remote.session);
      const state = yield* makeEnvironmentWeavraControlState(projectId).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
      );
      const subscription = yield* Queue.take(remote.subscriptions);
      expect(subscription.input).toEqual({ projectId });
      expect((yield* SubscriptionRef.get(state)).observation.stale).toBe(true);
      const canonical = observed(10);
      yield* Queue.offer(subscription.events, Effect.succeed(canonical));
      expect((yield* waitFor(state, (view) => !view.observation.stale)).observation).toEqual(
        canonical,
      );
    }).pipe(Effect.scoped),
);

it.effect("retains canonical display as stale on stream failure", () =>
  Effect.gen(function* () {
    const remote = yield* makeSession();
    const supervisor = yield* setup(remote.session);
    const state = yield* makeEnvironmentWeavraControlState(projectId).pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
    );
    const subscription = yield* Queue.take(remote.subscriptions);
    const canonical = observed(10);
    yield* Queue.offer(subscription.events, Effect.succeed(canonical));
    yield* waitFor(state, (view) => !view.observation.stale);
    yield* Queue.offer(
      subscription.events,
      Effect.fail(new WeavraControlTransportError({ code: "STATE_UNAVAILABLE" })),
    );
    const failed = yield* waitFor(state, (view) => view.observation.status === "ERROR");
    expect(failed.observation).toEqual({
      ...canonical,
      status: "ERROR",
      stale: true,
      errorCode: "STATE_UNAVAILABLE",
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "retains display through disconnect but rejects stale session callbacks until replacement canonical state",
  () =>
    Effect.gen(function* () {
      const old = yield* makeSession();
      const supervisor = yield* setup(old.session);
      const state = yield* makeEnvironmentWeavraControlState(projectId).pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
      );
      const oldSubscription = yield* Queue.take(old.subscriptions);
      const canonical = observed(10);
      yield* Queue.offer(oldSubscription.events, Effect.succeed(canonical));
      yield* waitFor(state, (view) => !view.observation.stale);
      yield* SubscriptionRef.set(supervisor.session, Option.none());
      const disconnected = yield* waitFor(
        state,
        (view) => view.observation.status === "DISCONNECTED",
      );
      expect(disconnected.observation).toEqual({
        ...canonical,
        status: "DISCONNECTED",
        stale: true,
      });
      const fresh = yield* makeSession();
      yield* SubscriptionRef.set(supervisor.session, Option.some(fresh.session));
      const freshSubscription = yield* Queue.take(fresh.subscriptions);
      expect((yield* SubscriptionRef.get(state)).observation).toMatchObject({
        state: canonical.state,
        stale: true,
      });
      yield* Queue.offer(oldSubscription.events, Effect.succeed(observed(999)));
      yield* Queue.offer(
        freshSubscription.events,
        Effect.succeed({ ...canonical, status: "CONNECTING", state: null, stale: true }),
      );
      const connecting = yield* waitFor(state, (view) => view.observation.status === "CONNECTING");
      expect(connecting.observation.state).toEqual(canonical.state);
      const replacement = observed(11, 1, "replacement-run");
      yield* Queue.offer(freshSubscription.events, Effect.succeed(replacement));
      expect((yield* waitFor(state, (view) => !view.observation.stale)).observation).toEqual(
        replacement,
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "discards preview and approval when capabilities announce a new owner epoch before its snapshot",
  () =>
    Effect.gen(function* () {
      const remote = yield* makeSession();
      const supervisor = yield* setup(remote.session);
      const state = yield* makeEnvironmentWeavraControlState(projectId, {
        observation: observed(10),
      }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
      const subscription = yield* Queue.take(remote.subscriptions);
      const replacement = observed(11, 1, "replacement-run", "replacement-owner");
      yield* Queue.offer(
        subscription.events,
        Effect.succeed({ ...replacement, status: "CONNECTING", state: null, stale: true }),
      );
      const connecting = yield* waitFor(
        state,
        (view) => view.observation.capabilities?.ownerId === "replacement-owner",
      );
      expect(connecting.observation.state).toBeNull();
      const next = {
        ...replacement,
        state: {
          ...canonicalState(11, 1, "replacement-run", "replacement-owner"),
          preview: null,
          pendingApproval: null,
        },
      };
      yield* Queue.offer(subscription.events, Effect.succeed(next));
      expect((yield* waitFor(state, (view) => !view.observation.stale)).observation).toEqual(next);
    }).pipe(Effect.scoped),
);

for (const [label, regressed] of [
  ["project revision", observed(9, 11)],
  ["same-run revision", observed(11, 9)],
  ["missing same-run revision", observed(11, null)],
] as const) {
  it.effect(`does not replace newer cached canonical state with regressed ${label}`, () =>
    Effect.gen(function* () {
      const remote = yield* makeSession();
      const supervisor = yield* setup(remote.session);
      const canonical = observed(10);
      const state = yield* makeEnvironmentWeavraControlState(projectId, {
        observation: canonical,
      }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
      const subscription = yield* Queue.take(remote.subscriptions);
      yield* Queue.offer(subscription.events, Effect.succeed(regressed));
      const rejected = yield* waitFor(
        state,
        (view) => view.observation.errorCode === "REVISION_REGRESSION",
      );
      expect(rejected.observation).toMatchObject({
        state: canonical.state,
        stale: true,
        status: "ERROR",
      });
      const next = observed(11, 11);
      yield* Queue.offer(subscription.events, Effect.succeed(next));
      expect((yield* waitFor(state, (view) => !view.observation.stale)).observation).toEqual(next);
    }).pipe(Effect.scoped),
  );
}

for (const errorCode of ["PROJECT_CHANGED", "PROJECT_UNAVAILABLE"] as const) {
  it.effect(
    `${errorCode} clears control state and capabilities instead of retaining cached authority`,
    () =>
      Effect.gen(function* () {
        const remote = yield* makeSession();
        const supervisor = yield* setup(remote.session);
        const state = yield* makeEnvironmentWeavraControlState(projectId, {
          observation: observed(10),
        }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
        const subscription = yield* Queue.take(remote.subscriptions);
        yield* Queue.offer(
          subscription.events,
          Effect.succeed({
            ...observed(10),
            status: "ERROR",
            errorCode,
            state: null,
            stale: true,
            observedAt: null,
          }),
        );
        const revoked = yield* waitFor(state, (view) => view.observation.errorCode === errorCode);
        expect(revoked.observation).toMatchObject({
          state: null,
          capabilities: null,
          stale: true,
          observedAt: null,
        });
      }).pipe(Effect.scoped),
  );
}

for (const [nextProject, nextRoot] of [
  [projectId, "/replacement-root"],
  [ProjectId.make("replacement-project"), "/root"],
] as const) {
  it.effect(
    `isolates canonical state and callbacks after key change to ${nextProject}:${nextRoot}`,
    () =>
      Effect.gen(function* () {
        const remote = yield* makeSession();
        const supervisor = yield* setup(remote.session);
        const h = yield* makeRuntime(supervisor);
        const oldAtom = h.atoms.stateAtom(target.environmentId, projectId, "/root");
        const stopOld = h.registry.mount(oldAtom);
        const oldSubscription = yield* Queue.take(remote.subscriptions);
        yield* Queue.offer(oldSubscription.events, Effect.succeed(observed(10)));
        yield* waitForAtom(h.registry, oldAtom, (view) => !view.observation.stale);
        const nextAtom = h.atoms.stateAtom(target.environmentId, nextProject, nextRoot);
        h.registry.mount(nextAtom);
        const nextSubscription = yield* Queue.take(remote.subscriptions);
        expect(nextSubscription.input).toEqual({ projectId: nextProject });
        const connecting = yield* waitForAtom(
          h.registry,
          nextAtom,
          (view) => view.support === "supported",
        );
        expect(connecting.observation).toMatchObject({ state: null, stale: true });
        stopOld();
        yield* Queue.offer(oldSubscription.events, Effect.succeed(observed(999)));
        yield* Queue.offer(
          nextSubscription.events,
          Effect.succeed({ ...observed(0), status: "CONNECTING", state: null, stale: true }),
        );
        expect(
          (yield* waitForAtom(
            h.registry,
            nextAtom,
            (view) => view.observation.status === "CONNECTING",
          )).observation.state,
        ).toBeNull();
        const next = observed(1, 1, "replacement-run", "replacement-owner");
        yield* Queue.offer(nextSubscription.events, Effect.succeed(next));
        expect(
          (yield* waitForAtom(h.registry, nextAtom, (view) => !view.observation.stale)).observation,
        ).toEqual(next);
      }).pipe(Effect.scoped),
  );
}

it.effect("old scope finalization cannot mark the replacement stream or its cache stale", () =>
  Effect.gen(function* () {
    const old = yield* makeSession();
    const fresh = yield* makeSession();
    const cache = { observation: observed(1) };
    const oldScope = yield* Scope.make();
    const oldSupervisor = yield* setup(old.session);
    yield* makeEnvironmentWeavraControlState(projectId, cache).pipe(
      Effect.provideService(EnvironmentSupervisor, oldSupervisor),
      Scope.provide(oldScope),
    );
    yield* Queue.take(old.subscriptions);
    const freshSupervisor = yield* setup(fresh.session);
    const state = yield* makeEnvironmentWeavraControlState(projectId, cache).pipe(
      Effect.provideService(EnvironmentSupervisor, freshSupervisor),
    );
    const subscription = yield* Queue.take(fresh.subscriptions);
    const next = observed(20);
    yield* Queue.offer(subscription.events, Effect.succeed(next));
    yield* waitFor(state, (view) => !view.observation.stale);
    yield* Scope.close(oldScope, Exit.void);
    expect(cache.observation).toEqual(next);
    expect((yield* SubscriptionRef.get(state)).observation).toEqual(next);
  }).pipe(Effect.scoped),
);

for (const capabilities of [{}, { weavraControl: false }]) {
  it.effect(`rejects commands without opt-in capability (${JSON.stringify(capabilities)})`, () =>
    Effect.gen(function* () {
      const remote = yield* makeSession(capabilities);
      const supervisor = yield* setup(remote.session);
      const h = yield* makeRuntime(supervisor);
      const result = yield* Effect.promise(() =>
        h.command.run(h.registry, { environmentId: target.environmentId, input: cancelInput }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(Cause.squash(result.cause)).toMatchObject({ code: "INCOMPATIBLE_CAPABILITIES" });
      expect(remote.sent).toEqual([]);
    }).pipe(Effect.scoped),
  );
}

it.effect("rejects commands without an active connected session", () =>
  Effect.gen(function* () {
    const remote = yield* makeSession();
    const supervisor = yield* setup(remote.session);
    yield* SubscriptionRef.set(supervisor.session, Option.none());
    const h = yield* makeRuntime(supervisor);
    const result = yield* Effect.promise(() =>
      h.command.run(h.registry, { environmentId: target.environmentId, input: cancelInput }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(Cause.squash(result.cause)).toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(remote.sent).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("rejects a command whose session changes while capability discovery is pending", () =>
  Effect.gen(function* () {
    const old = yield* makeSession();
    const fresh = yield* makeSession();
    const config = yield* old.session.initialConfig;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<typeof config>();
    const supervisor = yield* setup({
      ...old.session,
      initialConfig: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    const h = yield* makeRuntime(supervisor);
    const result = h.command.run(h.registry, {
      environmentId: target.environmentId,
      input: cancelInput,
    });
    yield* Deferred.await(started);
    yield* SubscriptionRef.set(supervisor.session, Option.some(fresh.session));
    yield* Deferred.succeed(release, config);
    const settled = yield* Effect.promise(() => result);
    expect(settled._tag).toBe("Failure");
    if (settled._tag === "Failure")
      expect(Cause.squash(settled.cause)).toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(old.sent).toEqual([]);
    expect(fresh.sent).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "sends a mutation once and never replays it into the replacement session after disconnect",
  () =>
    Effect.gen(function* () {
      const old = yield* makeSession();
      const supervisor = yield* setup(old.session);
      const h = yield* makeRuntime(supervisor);
      const atom = h.atoms.stateAtom(target.environmentId, projectId, "/root");
      h.registry.mount(atom);
      const subscription = yield* Queue.take(old.subscriptions);
      const canonical = observed(10);
      yield* Queue.offer(subscription.events, Effect.succeed(canonical));
      yield* waitForAtom(h.registry, atom, (view) => !view.observation.stale);
      const result = h.command.run(h.registry, {
        environmentId: target.environmentId,
        input: cancelInput,
      });
      const request = yield* Queue.take(old.requests);
      expect(request.input).toEqual(cancelInput);
      yield* SubscriptionRef.set(supervisor.session, Option.none());
      yield* waitForAtom(h.registry, atom, (view) => view.observation.status === "DISCONNECTED");
      yield* Deferred.fail(
        request.reply,
        new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" }),
      );
      const failed = yield* Effect.promise(() => result);
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure")
        expect(Cause.squash(failed.cause)).toMatchObject({ code: "TRANSPORT_CLOSED" });
      const fresh = yield* makeSession();
      yield* SubscriptionRef.set(supervisor.session, Option.some(fresh.session));
      const replacement = yield* Queue.take(fresh.subscriptions);
      yield* Queue.offer(replacement.events, Effect.succeed(observed(11)));
      yield* waitForAtom(h.registry, atom, (view) => !view.observation.stale);
      expect(old.sent).toEqual([cancelInput]);
      expect(fresh.sent).toEqual([]);
    }).pipe(Effect.scoped),
);

for (const request of [
  {
    protocolVersion: 1,
    id: "owner:11",
    ownerId: "owner",
    expectedProjectRevision: 10,
    type: "workflow.confirm",
    previewId: "preview",
    previewDigest: digest,
  },
  cancelInput.request,
  {
    protocolVersion: 1,
    id: "owner:11",
    ownerId: "owner",
    expectedProjectRevision: 10,
    type: "approval.resolve",
    runId: "run",
    expectedStateRevision: 10,
    approvalId: "approval",
    decision: "approve",
  },
] satisfies ReadonlyArray<WeavraControlInput["request"]>) {
  it.effect(
    `${request.type} acknowledgement cannot manufacture canonical run, approval, graph or evidence outcomes`,
    () =>
      Effect.gen(function* () {
        const remote = yield* makeSession();
        const supervisor = yield* setup(remote.session);
        const h = yield* makeRuntime(supervisor);
        const atom = h.atoms.stateAtom(target.environmentId, projectId, "/root");
        h.registry.mount(atom);
        const subscription = yield* Queue.take(remote.subscriptions);
        const canonical = observed(10);
        yield* Queue.offer(subscription.events, Effect.succeed(canonical));
        yield* waitForAtom(h.registry, atom, (view) => !view.observation.stale);
        const input: WeavraControlInput = { projectId, request };
        const result = h.command.run(h.registry, { environmentId: target.environmentId, input });
        const pending = yield* Queue.take(remote.requests);
        expect((yield* AtomRegistry.getResult(h.registry, atom)).observation).toEqual(canonical);
        yield* Deferred.succeed(pending.reply, accepted(input));
        expect(yield* Effect.promise(() => result)).toMatchObject({
          _tag: "Success",
          value: accepted(input),
        });
        expect(remote.sent).toEqual([input]);
        expect((yield* AtomRegistry.getResult(h.registry, atom)).observation).toEqual(canonical);
        const next = observed(11);
        yield* Queue.offer(subscription.events, Effect.succeed(next));
        expect(
          (yield* waitForAtom(
            h.registry,
            atom,
            (view) => view.observation.state?.projectRevision === 11,
          )).observation,
        ).toEqual(next);
      }).pipe(Effect.scoped),
  );
}

it.effect(
  "a canonical owner replacement cannot inherit the prior preview or pending approval",
  () =>
    Effect.gen(function* () {
      const remote = yield* makeSession();
      const supervisor = yield* setup(remote.session);
      const state = yield* makeEnvironmentWeavraControlState(projectId, {
        observation: observed(10),
      }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
      const subscription = yield* Queue.take(remote.subscriptions);
      const replacement: WeavraControlObservation = {
        ...observed(11, 1, "replacement-run", "replacement-owner"),
        state: {
          ...canonicalState(11, 1, "replacement-run", "replacement-owner"),
          preview: null,
          pendingApproval: null,
        },
      };
      yield* Queue.offer(subscription.events, Effect.succeed(replacement));
      expect((yield* waitFor(state, (view) => !view.observation.stale)).observation).toEqual(
        replacement,
      );
    }).pipe(Effect.scoped),
);
