import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ProjectId,
  type OrchestrationProjectShell,
  type WeavraBrowserCandidateSummary,
  type WeavraControlMutation,
  type WeavraControlObservation,
  WeavraControlState,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { make } from "./RuntimeController.ts";

const projectId = ProjectId.make("control-project");
const decodeCanonical = Schema.decodeEffect(Schema.fromJsonString(WeavraControlState));
const browserCandidate: WeavraBrowserCandidateSummary = {
  schemaVersion: 2,
  kind: "BROWSER_OBSERVATION_CANDIDATE",
  candidateId: "00000000-0000-4000-8000-000000000001",
  projectId: `sha256:${"a".repeat(64)}`,
  authority: "CANDIDATE_ONLY",
  scope: "LOCAL_STATIC_DOCUMENT",
  origin: "http://127.0.0.1:3880",
  documentIdentity: "http://127.0.0.1:3880/status",
  capturedAt: 100,
  pageRevision: `sha256:${"a".repeat(64)}`,
  source: {
    implementationRevision: `sha256:${"a".repeat(64)}`,
    readerRevision: "a".repeat(40),
    readerDigest: `sha256:${"a".repeat(64)}`,
    executableIdentityDigest: `sha256:${"a".repeat(64)}`,
    browserVersion: "Fixture",
  },
  freshness: { mode: "CAPTURE_ONLY", startedAt: 90, finishedAt: 100 },
  observationDigest: `sha256:${"a".repeat(64)}`,
  observationType: "target",
  observation: { target: { selector: "#status" }, exists: true, value: "Ready" },
  candidateDigest: `sha256:${"a".repeat(64)}`,
  cleanup: "CONFIRMED",
};
const registration = {
  candidateId: browserCandidate.candidateId,
  expectedCandidateDigest: browserCandidate.candidateDigest,
  checkId: "status-ready",
  origin: browserCandidate.origin,
  documentIdentity: browserCandidate.documentIdentity,
  target: browserCandidate.observation.target,
  assertion: { type: "text_equals" as const, expected: "Reviewed Ready" },
  freshness: { mode: "NEW_ISOLATED_CAPTURE" as const, maxAgeMs: 15000 },
};
// A protocol peer for adapter lifecycle tests, not Runtime completion evidence.
const source = `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
if(process.argv.slice(2).join('|')!=='bridge|--stdio|--project-trusted|--control')process.exit(41);
const mode=process.env.MODE;
const launch=existsSync('launch-count')?Number(readFileSync('launch-count','utf8'))+1:1;
writeFileSync('launch-count',String(launch));
const ownerId='owner-'+launch;
process.on('SIGTERM',()=>{writeFileSync('closed',String(launch));process.exit(0)});
const digest='sha256:'+'a'.repeat(64);
const candidate=${JSON.stringify(browserCandidate)};
let sequence=1;
const receipts=new Map();
const empty={status:{source:'durable-canonical-state',ownerObserved:false,state:'missing',writerPresent:false,run:null},graph:null,graphAvailable:false,evidence:null,configuration:{source:'project-config-not-frozen-run-config',status:'missing'}};
let state={ownerId,nextRequestId:ownerId+':1',projectRevision:0,stateRevision:null,ownedRunId:null,busy:false,cancelling:false,startFailure:null,preview:null,browserPreview:null,pendingApproval:null,snapshot:empty};
if(existsSync('canonical.json')){const old=JSON.parse(readFileSync('canonical.json','utf8'));state={...old,ownerId,nextRequestId:ownerId+':1',ownedRunId:null,busy:false,cancelling:false,preview:null,browserPreview:null,pendingApproval:null};}
const capabilities={authority:'Runtime/Kernel',control:'workflow-control-v1',ownerId,commands:['control.hello','control.snapshot','workflow.prepare','workflow.confirm','workflow.cancel','approval.resolve','browser.inspect','browser.prepare','browser.confirm'],maxRequestBytes:32768,maxResponseBytes:65536,resultLimit:64,previewTtlMs:300000,runtimeVersion:'0.85.1',readiness:mode==='not-setup'&&launch===1?'NOT_SETUP':'READY',recipes:[]};
const reply=(request,data,error)=>({protocolVersion:1,type:'control_response',id:request.id,command:request.type,ownerId,runId:state.snapshot.status.run?.runId??null,stateRevision:state.stateRevision,projectRevision:state.projectRevision,eventId:null,timestamp:1000,success:!error,...(error?{error:{code:error}}:{data})});
const save=()=>writeFileSync('canonical.json',JSON.stringify(state));
for await(const line of createInterface({input:process.stdin})){
 const request=JSON.parse(line);let response;
 if(request.type==='control.hello')response=reply(request,{kind:'capabilities',capabilities});
 else if(request.type==='control.snapshot'){
  if(existsSync('settle')&&state.busy){state.snapshot.status.run.status=state.cancelling?'CANCELLED':existsSync('decision')&&readFileSync('decision','utf8')==='reject'?'BLOCKED':'COMPLETED';state.snapshot.status.run.phase='COMPLETE';state.snapshot.status.writerPresent=false;state.busy=false;state.cancelling=false;state.pendingApproval=null;state.projectRevision++;state.stateRevision++;save();}
  response=reply(request,{kind:'snapshot',state});
 }else{
  appendFileSync('requests',request.type+'\\n');
  if(receipts.has(request.id)){const old=receipts.get(request.id);response=old.line===line?old.response:reply(request,null,'REQUEST_ID_REUSED');}
  else if(request.ownerId!==ownerId)response=reply(request,null,'OWNER_CHANGED');
  else if(request.expectedProjectRevision!==state.projectRevision)response=reply(request,null,'STALE_PROJECT');
  else{
   state.nextRequestId=ownerId+':'+(++sequence);
   if(request.type==='browser.inspect'){
    response=reply(request,{kind:'browser-state',state:{projectId:digest,candidates:[candidate],omittedCandidates:0,checks:existsSync('browser-check.json')?[{check:JSON.parse(readFileSync('browser-check.json','utf8')),required:true}]:[],omittedChecks:0,evidence:[],omittedEvidence:0}});
   }else if(request.type==='browser.prepare'){
    const {candidateId,expectedCandidateDigest,...definition}=request.registration;
    state.browserPreview={previewId:'browser-preview',previewDigest:digest,ownerId,projectRevision:state.projectRevision,expiresAt:9999999999999,candidate:mode==='browser-wrong-candidate'?{...candidate,candidateId:'00000000-0000-4000-8000-000000000002'}:candidate,check:{version:1,projectId:digest,...definition,registrationDigest:digest},isolation:'PRIVATE_HOME_PROFILE_CDP_PIPE_NOT_OS_SANDBOX'};
    response=reply(request,{kind:'browser-prepared',preview:state.browserPreview});
   }else if(request.type==='browser.confirm'){
    const check=state.browserPreview.check;writeFileSync('browser-check.json',JSON.stringify(check));state.browserPreview=null;
    response=reply(request,{kind:'browser-registered',check});
   }else if(request.type==='workflow.prepare'){
    state.preview={previewId:'preview',previewDigest:digest,ownerId,projectRevision:state.projectRevision,expiresAt:9999999999999,goal:request.goal,workflow:'STANDARD',executionMode:'EDIT',risk:mode==='approval'?'R3':'R1',allowedPaths:['src'],checks:[],acceptanceCriteria:[{id:'AC-1',statement:request.goal,checkIds:[],reviewRequired:true}],taskContractDigest:digest,recipe:null,configuration:{mutationMode:'compatible',verifierTrustMode:'compatible',verifierSandboxMode:'disabled',contextPackMode:'disabled',verificationRepairMode:'disabled',lspEnabled:false}};
    response=reply(request,{kind:'prepared',preview:state.preview});
   }else if(request.type==='workflow.confirm'){
    state.preview=null;state.projectRevision++;state.stateRevision=1;state.ownedRunId='run-1';state.busy=true;
    state.snapshot.status={source:'durable-canonical-state',ownerObserved:false,state:'available',writerPresent:true,run:{runId:'run-1',status:mode==='approval'?'WAITING_APPROVAL':'RUNNING',phase:'IMPLEMENT',workflow:'STANDARD',risk:mode==='approval'?'R3':'R1',executionMode:'EDIT',codeRevision:0,currentStep:{stepId:'implement',attempt:0},activeAgentCount:1,taskContractDigest:digest,createdAt:1,updatedAt:1}};
    if(mode==='approval')state.pendingApproval={approvalId:'approval-1',runId:'run-1',stateRevision:1,projectRevision:state.projectRevision,risk:'R3',operation:'delete-file',role:'Developer',step:{stepId:'implement',attempt:0},path:'src/old.js',bytes:4,preconditionDigest:'b'.repeat(64),expiresAt:9999999999999,explanation:'Delete one tracked file'};
    save();writeFileSync('confirm-received','yes');
    if(mode==='exit-confirm'&&launch===1)process.exit(0);
    if(mode==='delay-confirm')while(!existsSync('release'))await new Promise(r=>setTimeout(r,5));
    response=reply(request,{kind:'accepted',requestId:request.id,command:request.type,runId:null});
   }else{
    if(request.expectedStateRevision!==state.stateRevision)response=reply(request,null,'STALE_RUN');
    else{if(request.type==='workflow.cancel')state.cancelling=true;else{writeFileSync('decision',request.decision);state.pendingApproval=null;}response=reply(request,{kind:'accepted',requestId:request.id,command:request.type,runId:state.ownedRunId});}
   }
   receipts.set(request.id,{line,response});
  }
 }
 process.stdout.write(JSON.stringify(response)+'\\n');
 process.stderr.write('PRIVATE_CONTROL_STDERR_MARKER\\n');
}
`;
function project(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: projectId,
    title: "Fixture",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}
function next(
  queue: Queue.Queue<WeavraControlObservation>,
  predicate: (value: WeavraControlObservation) => boolean,
) {
  return Stream.fromQueue(queue).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}
const connected = (queue: Queue.Queue<WeavraControlObservation>) =>
  next(queue, (value) => value.status === "CONNECTED" && !value.stale);
const setup = Effect.fn("test.control.setup")(function* (mode = "normal") {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "weavra-control-owner-" });
  const executable = writeFakeCli({
    directory: root,
    name: "control owner",
    source,
    env: { MODE: mode },
  });
  let selected: OrchestrationProjectShell | undefined = project(root);
  const controller = yield* make().pipe(
    Effect.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (id) =>
          Effect.sync(() => (id === projectId ? Option.fromUndefinedOr(selected) : Option.none())),
      }),
    ),
    Effect.provideService(HostProcessEnvironment, {
      PATH: process.env.PATH,
      T3_WEAVRA_EXECUTABLE: executable,
      T3_WEAVRA_CONTROL: "1",
    }),
  );
  const queue = yield* Queue.unbounded<WeavraControlObservation>();
  const consumer = yield* controller.observe(projectId).pipe(
    Stream.runForEach((value) => Queue.offer(queue, value)),
    Effect.forkScoped,
  );
  const initial =
    mode === "not-setup"
      ? yield* next(queue, (value) => value.status === "NOT_SETUP")
      : yield* connected(queue);
  return {
    fs,
    root,
    controller,
    queue,
    consumer,
    initial,
    select: (value: OrchestrationProjectShell | undefined) => {
      selected = value;
    },
  };
});
function fields(state: WeavraControlState) {
  return {
    protocolVersion: 1 as const,
    id: state.nextRequestId,
    ownerId: state.ownerId,
    expectedProjectRevision: state.projectRevision,
  };
}
const start = Effect.fn("test.control.start")(function* (
  fixture: Effect.Success<ReturnType<typeof setup>>,
) {
  const state = fixture.initial.state!;
  const prepared = yield* fixture.controller.command({
    projectId,
    request: { ...fields(state), type: "workflow.prepare", goal: "Fix fixture" },
  });
  if (!prepared.success || prepared.data.kind !== "prepared")
    throw new Error("Missing Runtime plan");
  const planned = (yield* connected(fixture.queue)).state!;
  const request = {
    ...fields(planned),
    type: "workflow.confirm" as const,
    previewId: prepared.data.preview.previewId,
    previewDigest: prepared.data.preview.previewDigest,
  };
  const response = yield* fixture.controller.command({ projectId, request });
  return { request, response, state: (yield* connected(fixture.queue)).state! };
});
const waitFile = Effect.fn("test.control.waitFile")(function* (
  fs: FileSystem.FileSystem,
  file: string,
) {
  yield* fs.exists(file).pipe(Effect.repeat({ until: Boolean }));
});

it.effect(
  "retains execution across all consumer disconnects and converges only from canonical snapshots",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const { response, state } = yield* start(fixture);
      expect(response).toMatchObject({ success: true, data: { kind: "accepted", runId: null } });
      expect(state.snapshot.status).toMatchObject({
        writerPresent: true,
        run: { status: "RUNNING" },
      });
      yield* Fiber.interrupt(fixture.consumer);
      expect(yield* fixture.fs.exists(`${fixture.root}/closed`)).toBe(false);
      const second = yield* Queue.unbounded<WeavraControlObservation>();
      yield* fixture.controller.observe(projectId).pipe(
        Stream.runForEach((value) => Queue.offer(second, value)),
        Effect.forkScoped,
      );
      expect((yield* connected(second)).state?.ownerId).toBe(state.ownerId);
      expect(yield* fixture.fs.readFileString(`${fixture.root}/launch-count`)).toBe("1");
      yield* fixture.fs.writeFileString(`${fixture.root}/settle`, "finish");
      yield* TestClock.adjust("2 seconds");
      const final = yield* next(
        second,
        (value) => value.state?.snapshot.status.run?.status === "COMPLETED",
      );
      expect(final.state).toMatchObject({
        busy: false,
        snapshot: { status: { writerPresent: false } },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns Runtime duplicate and stale decisions without a second start", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const started = yield* start(fixture);
    expect(yield* fixture.controller.command({ projectId, request: started.request })).toEqual(
      started.response,
    );
    const conflict = yield* fixture.controller.command({
      projectId,
      request: { ...started.request, previewId: "changed" },
    });
    expect(conflict).toMatchObject({ success: false, error: { code: "REQUEST_ID_REUSED" } });
    const stale = yield* fixture.controller.command({
      projectId,
      request: {
        ...fields(started.state),
        expectedProjectRevision: 0,
        type: "workflow.cancel",
        runId: "run-1",
        expectedStateRevision: 1,
      },
    });
    expect(stale).toMatchObject({ success: false, error: { code: "STALE_PROJECT" } });
    const wrongRevision = yield* fixture.controller.command({
      projectId,
      request: {
        ...fields(started.state),
        type: "workflow.cancel",
        runId: "run-1",
        expectedStateRevision: 0,
      },
    });
    expect(wrongRevision).toMatchObject({ success: false, error: { code: "STALE_RUN" } });
    const canonical = yield* decodeCanonical(
      yield* fixture.fs.readFileString(`${fixture.root}/canonical.json`),
    );
    expect(canonical.snapshot.status.run?.status).toBe("RUNNING");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancel acknowledgement leaves RUNNING and writer present until canonical cleanup", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const started = yield* start(fixture);
    const response = yield* fixture.controller.command({
      projectId,
      request: {
        ...fields(started.state),
        type: "workflow.cancel",
        runId: "run-1",
        expectedStateRevision: 1,
      },
    });
    expect(response).toMatchObject({
      success: true,
      data: { command: "workflow.cancel", kind: "accepted" },
    });
    const pending = (yield* connected(fixture.queue)).state!;
    expect(pending).toMatchObject({
      cancelling: true,
      snapshot: { status: { writerPresent: true, run: { status: "RUNNING" } } },
    });
    yield* fixture.fs.writeFileString(`${fixture.root}/settle`, "cleanup");
    yield* TestClock.adjust("2 seconds");
    expect(
      (yield* next(
        fixture.queue,
        (value) => value.state?.snapshot.status.run?.status === "CANCELLED",
      )).state,
    ).toMatchObject({ busy: false, snapshot: { status: { writerPresent: false } } });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
for (const decision of ["approve", "reject"] as const) {
  it.effect(
    `forwards only a pending ${decision} and observes the independent canonical outcome`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup("approval");
        const started = yield* start(fixture);
        const pending = started.state.pendingApproval!;
        const response = yield* fixture.controller.command({
          projectId,
          request: {
            ...fields(started.state),
            type: "approval.resolve",
            runId: pending.runId,
            expectedStateRevision: pending.stateRevision,
            approvalId: pending.approvalId,
            decision,
          },
        });
        expect(response).toMatchObject({ success: true, data: { kind: "accepted" } });
        const acknowledged = (yield* connected(fixture.queue)).state!;
        expect(acknowledged.snapshot.status.run?.status).toBe("WAITING_APPROVAL");
        expect(yield* fixture.fs.readFileString(`${fixture.root}/decision`)).toBe(decision);
        yield* fixture.fs.writeFileString(`${fixture.root}/settle`, "canonical");
        yield* TestClock.adjust("2 seconds");
        const final = yield* next(
          fixture.queue,
          (value) =>
            value.state?.snapshot.status.run?.status ===
            (decision === "approve" ? "COMPLETED" : "BLOCKED"),
        );
        expect(final.state?.pendingApproval).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("caller interruption does not interrupt an already accepted server-owned command", () =>
  Effect.gen(function* () {
    const fixture = yield* setup("delay-confirm");
    const call = yield* start(fixture).pipe(Effect.forkScoped);
    yield* waitFile(fixture.fs, `${fixture.root}/confirm-received`);
    yield* Fiber.interrupt(call);
    yield* Fiber.interrupt(fixture.consumer);
    expect(yield* fixture.fs.exists(`${fixture.root}/closed`)).toBe(false);
    yield* fixture.fs.writeFileString(`${fixture.root}/release`, "reply");
    const second = yield* Queue.unbounded<WeavraControlObservation>();
    yield* fixture.controller.observe(projectId).pipe(
      Stream.runForEach((value) => Queue.offer(second, value)),
      Effect.forkScoped,
    );
    const running = yield* next(
      second,
      (value) => value.state?.snapshot.status.run?.status === "RUNNING",
    );
    expect(running.state?.busy).toBe(true);
    expect(
      (yield* fixture.fs.readFileString(`${fixture.root}/requests`))
        .split("\n")
        .filter((value) => value === "workflow.confirm"),
    ).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("process loss after acceptance reconnects observation without replaying a mutation", () =>
  Effect.gen(function* () {
    const fixture = yield* setup("exit-confirm");
    const lost = yield* start(fixture).pipe(Effect.result);
    expect(lost).toMatchObject({ _tag: "Failure", failure: { code: "TRANSPORT_CLOSED" } });
    yield* next(fixture.queue, (value) => value.stale && value.status === "DISCONNECTED");
    yield* TestClock.adjust("5 seconds");
    const fresh = (yield* connected(fixture.queue)).state!;
    expect(fresh).toMatchObject({
      ownerId: "owner-2",
      ownedRunId: null,
      busy: false,
      snapshot: { status: { writerPresent: true, run: { status: "RUNNING" } } },
    });
    expect(
      (yield* fixture.fs.readFileString(`${fixture.root}/requests`))
        .split("\n")
        .filter((value) => value === "workflow.confirm"),
    ).toHaveLength(1);
    const old: WeavraControlMutation = {
      protocolVersion: 1,
      id: "owner-1:2",
      ownerId: "owner-1",
      expectedProjectRevision: 0,
      type: "workflow.confirm",
      previewId: "preview",
      previewDigest: `sha256:${"a".repeat(64)}`,
    };
    expect(yield* fixture.controller.command({ projectId, request: old })).toMatchObject({
      success: false,
      error: { code: "OWNER_CHANGED" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reopens a stopped not-setup owner after explicit resubscription", () =>
  Effect.gen(function* () {
    const fixture = yield* setup("not-setup");
    yield* waitFile(fixture.fs, `${fixture.root}/closed`);
    yield* Fiber.interrupt(fixture.consumer);
    const observation = yield* fixture.controller.observe(projectId).pipe(
      Stream.filter((value) => value.status === "CONNECTED"),
      Stream.runHead,
    );
    expect(Option.getOrThrow(observation).state?.ownerId).toBe("owner-2");
    expect(yield* fixture.fs.readFileString(`${fixture.root}/launch-count`)).toBe("2");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not create a control process before observation or for a forged project", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const request = {
      ...fields(fixture.initial.state!),
      type: "workflow.prepare" as const,
      goal: "Fix fixture",
    };
    expect(
      yield* fixture.controller
        .command({ projectId: ProjectId.make("forged"), request })
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { code: "PROJECT_UNAVAILABLE" } });
    expect(yield* fixture.fs.exists(`${fixture.root}/requests`)).toBe(false);
    fixture.select(undefined);
    expect(
      yield* fixture.controller.command({ projectId, request }).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { code: "PROJECT_UNAVAILABLE" } });
    yield* TestClock.adjust("2 seconds");
    expect(
      yield* next(fixture.queue, (value) => value.errorCode === "PROJECT_UNAVAILABLE"),
    ).toMatchObject({ state: null, stale: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a changed canonical root before forwarding another mutation", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const started = yield* start(fixture);
    const replacement = yield* fixture.fs.makeTempDirectoryScoped({ prefix: "weavra-other-root-" });
    fixture.select(project(replacement));
    const result = yield* fixture.controller
      .command({
        projectId,
        request: {
          ...fields(started.state),
          type: "workflow.cancel",
          runId: "run-1",
          expectedStateRevision: 1,
        },
      })
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "TRANSPORT_CLOSED" } });
    expect(
      (yield* fixture.fs.readFileString(`${fixture.root}/requests`)).includes("workflow.cancel"),
    ).toBe(false);
    yield* TestClock.adjust("2 seconds");
    expect(
      yield* next(fixture.queue, (value) => value.errorCode === "PROJECT_CHANGED"),
    ).toMatchObject({ stale: true, state: null });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "forwards browser review and confirmation while keeping registration separate from Run evidence",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const inspected = yield* fixture.controller.command({
        projectId,
        request: { ...fields(fixture.initial.state!), type: "browser.inspect" },
      });
      expect(inspected).toMatchObject({
        success: true,
        data: {
          kind: "browser-state",
          state: { candidates: [browserCandidate], checks: [], evidence: [] },
        },
      });
      const inspectedState = (yield* connected(fixture.queue)).state!;
      const prepared = yield* fixture.controller.command({
        projectId,
        request: { ...fields(inspectedState), type: "browser.prepare", registration },
      });
      if (!prepared.success || prepared.data.kind !== "browser-prepared")
        throw new Error("Missing browser preview");
      expect(prepared.data.preview.check.assertion).toEqual(registration.assertion);
      expect(yield* fixture.fs.exists(`${fixture.root}/browser-check.json`)).toBe(false);
      const planned = (yield* connected(fixture.queue)).state!;
      const confirmed = yield* fixture.controller.command({
        projectId,
        request: {
          ...fields(planned),
          type: "browser.confirm",
          previewId: prepared.data.preview.previewId,
          previewDigest: prepared.data.preview.previewDigest,
        },
      });
      expect(confirmed).toMatchObject({
        success: true,
        data: { kind: "browser-registered", check: prepared.data.preview.check },
      });
      const canonical = (yield* connected(fixture.queue)).state!;
      expect(canonical.snapshot.status.run).toBeNull();
      expect(canonical.snapshot.evidence).toBeNull();
      expect(canonical.browserPreview).toBeNull();
      const refreshed = yield* fixture.controller.command({
        projectId,
        request: { ...fields(canonical), type: "browser.inspect" },
      });
      expect(refreshed).toMatchObject({
        success: true,
        data: {
          kind: "browser-state",
          state: {
            checks: [{ check: prepared.data.preview.check, required: true }],
            evidence: [],
          },
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a browser preview bound to a different candidate", () =>
  Effect.gen(function* () {
    const fixture = yield* setup("browser-wrong-candidate");
    const result = yield* fixture.controller
      .command({
        projectId,
        request: { ...fields(fixture.initial.state!), type: "browser.prepare", registration },
      })
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_PAYLOAD" } });
    expect(yield* fixture.fs.exists(`${fixture.root}/browser-check.json`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
