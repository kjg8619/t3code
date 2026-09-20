import { WeavraFitnessError, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createEnvironmentWeavraFitnessCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcCommand(runtime, {
    label: "environment-command:weavra:fitness-read",
    tag: WS_METHODS.weavraFitness,
    execute: (input) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const session = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(session)) return yield* new WeavraFitnessError({ code: "UNAVAILABLE" });
        const config = yield* session.value.initialConfig.pipe(Effect.orElseSucceed(() => null));
        const active = yield* SubscriptionRef.get(supervisor.session);
        if (
          Option.isNone(active) ||
          active.value !== session.value ||
          config?.environment.capabilities.weavraFitness !== true
        )
          return yield* new WeavraFitnessError({ code: "UNAVAILABLE" });
        return yield* request(WS_METHODS.weavraFitness, input);
      }),
  });
}
