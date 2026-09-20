import {
  WeavraFitnessComparison,
  WeavraFitnessError,
  WeavraFitnessHistory,
  WeavraFitnessInput,
  type WeavraFitnessResponse,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const decodeInput = Schema.decodeEffect(WeavraFitnessInput, { onExcessProperty: "error" });
const decodeHistory = Schema.decodeEffect(Schema.fromJsonString(WeavraFitnessHistory), {
  onExcessProperty: "error",
});
const decodeComparison = Schema.decodeEffect(Schema.fromJsonString(WeavraFitnessComparison), {
  onExcessProperty: "error",
});

/** Fixed read-only argv. No provider execution, arbitrary paths, environment, or shell from RPC. */
export const readFitness = Effect.fn("weavra.readFitness")(function* (
  executable: string,
  cwd: string,
  env: Record<string, string>,
  input: WeavraFitnessInput,
) {
  const request = yield* decodeInput(input).pipe(
    Effect.mapError(() => new WeavraFitnessError({ code: "INVALID_PAYLOAD" })),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const args =
    request.command === "list"
      ? ["fitness", "list", "--json"]
      : ["fitness", "compare", request.left, request.right, "--json"];
  const child = yield* spawner
    .spawn(
      ChildProcess.make(executable, args, {
        cwd,
        env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      }),
    )
    .pipe(Effect.mapError(() => new WeavraFitnessError({ code: "UNAVAILABLE" })));
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
  const buffer = Buffer.alloc(256 * 1024);
  let length = 0;
  yield* child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        if (length + chunk.length > buffer.length)
          return yield* new WeavraFitnessError({ code: "INVALID_PAYLOAD" });
        buffer.set(chunk, length);
        length += chunk.length;
      }),
    ),
    Effect.mapError(() => new WeavraFitnessError({ code: "INVALID_PAYLOAD" })),
  );
  const exit = yield* child.exitCode.pipe(
    Effect.mapError(() => new WeavraFitnessError({ code: "UNAVAILABLE" })),
  );
  if (exit !== 0) return yield* new WeavraFitnessError({ code: "UNAVAILABLE" });
  const value = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
    catch: () => new WeavraFitnessError({ code: "INVALID_PAYLOAD" }),
  });
  if (request.command === "list") {
    const data = yield* decodeHistory(value).pipe(
      Effect.mapError(() => new WeavraFitnessError({ code: "INVALID_PAYLOAD" })),
    );
    return { command: "list", data } satisfies WeavraFitnessResponse;
  }
  const data = yield* decodeComparison(value).pipe(
    Effect.mapError(() => new WeavraFitnessError({ code: "INVALID_PAYLOAD" })),
  );
  if (
    data.left.id !== request.left ||
    data.right.id !== request.right ||
    data.comparable !== Object.values(data.compatibility).every(Boolean)
  )
    return yield* new WeavraFitnessError({ code: "INVALID_PAYLOAD" });
  return { command: "compare", data } satisfies WeavraFitnessResponse;
});
