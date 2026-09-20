import {
  EnvironmentId,
  ProjectId,
  WeavraControlTransportError,
  WS_METHODS,
  type WeavraControlObservation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request, subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentRpcCommand, followStreamInEnvironment } from "./runtime.ts";

export interface WeavraControlViewState {
  readonly support: "unknown" | "supported" | "unsupported";
  readonly observation: WeavraControlObservation;
}
interface WeavraControlCache {
  observation?: WeavraControlObservation;
  owner?: symbol;
}
const empty: WeavraControlObservation = {
  status: "DISCONNECTED",
  state: null,
  capabilities: null,
  stale: true,
  observedAt: null,
  errorCode: null,
};
const initial: WeavraControlViewState = { support: "unknown", observation: empty };

/** Each session must receive canonical control state before cached data becomes current. */
export const makeEnvironmentWeavraControlState = Effect.fn("EnvironmentWeavraControlState.make")(
  function* (projectId: ProjectId, cache: WeavraControlCache = {}) {
    const supervisor = yield* EnvironmentSupervisor;
    const owner = Symbol();
    cache.owner = owner;
    let current: WeavraControlViewState = {
      support: "unknown",
      observation: { ...(cache.observation ?? empty), status: "DISCONNECTED", stale: true },
    };
    let producer: RpcSession | undefined;
    const state = yield* SubscriptionRef.make(current);
    const update = (next: WeavraControlViewState) =>
      Effect.gen(function* () {
        if (cache.owner !== owner) return;
        current = next;
        cache.observation = next.observation;
        yield* SubscriptionRef.set(state, next);
      });
    const unavailable = () =>
      update({
        ...current,
        observation: {
          ...current.observation,
          status: "ERROR",
          stale: true,
          errorCode: "STATE_UNAVAILABLE",
        },
      });
    yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.runForEach((session) => {
        if (Option.isSome(session) && producer === session.value) return Effect.void;
        producer = Option.getOrUndefined(session);
        return update({
          support: "unknown",
          observation: {
            ...current.observation,
            status: Option.isNone(session) ? "DISCONNECTED" : "RECONNECTING",
            stale: true,
          },
        });
      }),
      Effect.forkScoped,
    );
    yield* subscribeDynamicWithSession(
      WS_METHODS.weavraControlObserve,
      (session) =>
        Effect.gen(function* () {
          const config = yield* session.initialConfig.pipe(Effect.orElseSucceed(() => null));
          const active = yield* SubscriptionRef.get(supervisor.session);
          if (Option.isNone(active) || active.value !== session || cache.owner !== owner)
            return yield* Effect.never;
          producer = session;
          const supported = config?.environment.capabilities.weavraControl === true;
          yield* update({
            support: supported ? "supported" : "unsupported",
            observation: { ...current.observation, status: "RECONNECTING", stale: true },
          });
          // No unknown feature RPC is ever sent to an older environment.
          if (!supported) return yield* Effect.never;
          return { projectId };
        }),
      { onExpectedFailure: unavailable, onDefect: unavailable },
    ).pipe(
      Stream.runForEach(([session, observation]) =>
        Effect.gen(function* () {
          const active = yield* SubscriptionRef.get(supervisor.session);
          if (Option.isNone(active) || active.value !== session || cache.owner !== owner) return;
          producer = session;
          const previous = current.observation;
          const oldState = previous.state;
          const nextState = observation.state;
          if (
            observation.errorCode === "PROJECT_CHANGED" ||
            observation.errorCode === "PROJECT_UNAVAILABLE"
          ) {
            yield* update({
              support: "supported",
              observation: { ...observation, state: null, capabilities: null, stale: true },
            });
            return;
          }
          const ownerChanged =
            oldState !== null &&
            ((nextState !== null && nextState.ownerId !== oldState.ownerId) ||
              (observation.capabilities !== null &&
                observation.capabilities.ownerId !== oldState.ownerId));
          if (
            oldState &&
            nextState &&
            (nextState.projectRevision < oldState.projectRevision ||
              (oldState.snapshot.status.run?.runId === nextState.snapshot.status.run?.runId &&
                oldState.stateRevision !== null &&
                (nextState.stateRevision === null ||
                  nextState.stateRevision < oldState.stateRevision)))
          ) {
            yield* update({
              support: "supported",
              observation: {
                ...(ownerChanged ? { ...observation, state: null } : previous),
                status: "ERROR",
                stale: true,
                errorCode: "REVISION_REGRESSION",
              },
            });
            return;
          }
          // Never carry a prior owner's preview or approval into a new control epoch.
          const retained =
            nextState === null && observation.stale && oldState !== null && !ownerChanged
              ? { ...observation, state: oldState, observedAt: previous.observedAt }
              : observation;
          yield* update({ support: "supported", observation: retained });
        }),
      ),
      Effect.catchCause(() => unavailable()),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (cache.owner === owner) {
          cache.observation = { ...current.observation, stale: true };
          delete cache.owner;
        }
      }),
    );
    return state;
  },
);

export function createEnvironmentWeavraControlStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cacheFamily = Atom.family((key: string) =>
    Atom.make((): WeavraControlCache => ({})).pipe(
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`weavra-control-cache:${key}`),
    ),
  );
  const family = Atom.family((key: string) => {
    const [environmentId, projectId] = JSON.parse(key) as [string, string, string];
    const cacheAtom = cacheFamily(key);
    return runtime
      .atom(
        (get) => {
          get.mount(cacheAtom);
          const cache = get.once(cacheAtom);
          return followStreamInEnvironment(
            EnvironmentId.make(environmentId),
            Stream.unwrap(
              makeEnvironmentWeavraControlState(ProjectId.make(projectId), cache).pipe(
                Effect.map(SubscriptionRef.changes),
              ),
            ),
          );
        },
        { initialValue: initial },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`weavra-control-observation:${key}`));
  });
  return {
    stateAtom: (environmentId: EnvironmentId, projectId: ProjectId, workspaceRoot: string) =>
      family(JSON.stringify([environmentId, projectId, workspaceRoot])),
  };
}

export function createEnvironmentWeavraControlCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcCommand(runtime, {
    label: "environment-command:weavra:control",
    tag: WS_METHODS.weavraControl,
    execute: (input) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const session = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(session)) {
          return yield* Effect.fail(new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" }));
        }
        const config = yield* session.value.initialConfig.pipe(Effect.orElseSucceed(() => null));
        const active = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(active) || active.value !== session.value) {
          return yield* Effect.fail(new WeavraControlTransportError({ code: "TRANSPORT_CLOSED" }));
        }
        if (config?.environment.capabilities.weavraControl !== true) {
          return yield* Effect.fail(
            new WeavraControlTransportError({ code: "INCOMPATIBLE_CAPABILITIES" }),
          );
        }
        return yield* request(WS_METHODS.weavraControl, input);
      }),
  });
}
