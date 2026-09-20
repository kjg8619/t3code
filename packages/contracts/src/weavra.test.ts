import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { WeavraHostEvent, WeavraHostRequest } from "./weavra.ts";

const request = Schema.decodeUnknownSync(WeavraHostRequest, { onExcessProperty: "error" });
const event = Schema.decodeUnknownSync(WeavraHostEvent, { onExcessProperty: "error" });

it("refuses execution, approval, cancellation, filesystem, and completion-authority requests", () => {
  for (const type of [
    "start",
    "cancel",
    "approve",
    "reject",
    "write",
    "edit",
    "set-policy",
    "task-contract",
    "complete",
    "pass",
  ]) {
    expect(() => request({ protocolVersion: 1, id: "request", type })).toThrow();
  }
  expect(() =>
    request({ protocolVersion: 1, id: "request", type: "snapshot", cwd: "/another-checkout" }),
  ).toThrow();
});

it("accepts actual observation identity while refusing unknown events and private event fields", () => {
  const observed = {
    protocolVersion: 1,
    type: "runtime_event",
    runId: "run",
    stateRevision: 3,
    projectRevision: null,
    eventId: "run:4",
    timestamp: 1000,
    event: { type: "StepStarted", sequence: 4, step: { stepId: "implement", attempt: 1 } },
  };
  expect(event(observed)).toMatchObject({
    eventId: "run:4",
    stateRevision: 3,
    event: { type: "StepStarted" },
  });
  expect(() =>
    event({ ...observed, event: { ...observed.event, type: "InventedEvent" } }),
  ).toThrow();
  expect(() =>
    event({ ...observed, event: { ...observed.event, reason: "PRIVATE_RAW_TOOL_OUTPUT" } }),
  ).toThrow();
  expect(() => event({ ...observed, credentials: "PRIVATE_TOKEN" })).toThrow();
  expect(() => event({ ...observed, protocolVersion: 2 })).toThrow();
});
