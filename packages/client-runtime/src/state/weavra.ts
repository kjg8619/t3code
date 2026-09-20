import { EnvironmentId, ProjectId, WS_METHODS, type WeavraObservation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export interface WeavraViewState {
  readonly support: "unknown" | "supported" | "unsupported";
  readonly observation: WeavraObservation;
}
interface WeavraCache {
  observation?: WeavraObservation;
  owner?: symbol;
}
const empty: WeavraObservation = {
  status: "DISCONNECTED",
  snapshot: null,
  stale: true,
  observedAt: null,
  runtimeVersion: null,
  errorCode: null,
};
const initial: WeavraViewState = { support: "unknown", observation: empty };

/** Each session must receive a canonical snapshot before cached data becomes current. */
export const makeEnvironmentWeavraState = Effect.fn("EnvironmentWeavraState.make")(function* (
  projectId: ProjectId,
  cache: WeavraCache = {},
) {
  const supervisor = yield* EnvironmentSupervisor;
  const owner = Symbol();
  cache.owner = owner;
  let current: WeavraViewState = {
    support: "unknown",
    observation: { ...(cache.observation ?? empty), status: "DISCONNECTED", stale: true },
  };
  let producer: RpcSession | undefined;
  const state = yield* SubscriptionRef.make(current);
  const update = (next: WeavraViewState) =>
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
    WS_METHODS.weavraObserve,
    (session) =>
      Effect.gen(function* () {
        const config = yield* session.initialConfig.pipe(Effect.orElseSucceed(() => null));
        const active = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(active) || active.value !== session || cache.owner !== owner)
          return yield* Effect.never;
        producer = session;
        const supported = config?.environment.capabilities.weavraReadOnly === true;
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
        const oldSnapshot = previous.snapshot;
        const nextSnapshot = observation.snapshot;
        if (
          oldSnapshot &&
          nextSnapshot &&
          ((oldSnapshot.projectRevision !== null &&
            (nextSnapshot.projectRevision === null ||
              nextSnapshot.projectRevision < oldSnapshot.projectRevision)) ||
            (oldSnapshot.runId === nextSnapshot.runId &&
              oldSnapshot.stateRevision !== null &&
              (nextSnapshot.stateRevision === null ||
                nextSnapshot.stateRevision < oldSnapshot.stateRevision)))
        ) {
          yield* update({
            support: "supported",
            observation: {
              ...previous,
              status: "ERROR",
              stale: true,
              errorCode: "REVISION_REGRESSION",
            },
          });
          return;
        }
        // Initial bridge connection messages have no canonical data; keep the old view visibly stale.
        const retained =
          observation.snapshot === null &&
          observation.stale &&
          previous.snapshot !== null &&
          observation.errorCode !== "PROJECT_CHANGED" &&
          observation.errorCode !== "PROJECT_UNAVAILABLE"
            ? { ...observation, snapshot: previous.snapshot, observedAt: previous.observedAt }
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
});

export function createEnvironmentWeavraStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cacheFamily = Atom.family((key: string) =>
    Atom.make((): WeavraCache => ({})).pipe(
      Atom.setIdleTTL(5 * 60_000),
      Atom.withLabel(`weavra-cache:${key}`),
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
              makeEnvironmentWeavraState(ProjectId.make(projectId), cache).pipe(
                Effect.map(SubscriptionRef.changes),
              ),
            ),
          );
        },
        { initialValue: initial },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`weavra-observation:${key}`));
  });
  return {
    stateAtom: (environmentId: EnvironmentId, projectId: ProjectId, workspaceRoot: string) =>
      family(JSON.stringify([environmentId, projectId, workspaceRoot])),
  };
}
