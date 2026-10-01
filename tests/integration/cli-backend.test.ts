import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildArgs } from "../../src/backends/cli/args.ts";
import { createCliBackend, type ExecCli } from "../../src/backends/cli/cli-backend.ts";
import type { RunEvent, RunRequest } from "../../src/backends/types.ts";
import { AppError, type ErrorCode } from "../../src/errors.ts";
import type { ProcessRunner, RunSpec } from "../../src/process/runner.ts";
import { FakeClock } from "../helpers/app.ts";
import { FAKE_CLAUDE, isAlive, makeRunner, waitForDeath } from "../helpers/process.ts";

const T = 20_000;
const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../fixtures/streams/${name}`, import.meta.url));

const replay = (fixture: string | undefined, exitCode = 0, stderrFile?: string) => ({
  FAKE_CLAUDE_SCENARIO: "replay",
  ...(fixture ? { FAKE_CLAUDE_FIXTURE: fixturePath(fixture) } : {}),
  ...(stderrFile ? { FAKE_CLAUDE_STDERR_FILE: fixturePath(stderrFile) } : {}),
  FAKE_CLAUDE_EXIT: String(exitCode),
});

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  prompt: "Reply with exactly the word: pong",
  tools: [],
  timeoutMs: 30_000,
  ...overrides,
});

function setup(
  scenarioEnv: Record<string, string>,
  options: { clock?: FakeClock; exec?: ExecCli } = {},
) {
  const { runner, logger } = makeRunner(options.clock ? { clock: options.clock } : {});
  const specs: RunSpec[] = [];
  const pids: number[] = [];
  const recording: ProcessRunner = {
    async start(spec) {
      specs.push(spec);
      const run = await runner.start(spec);
      pids.push(run.pid);
      return run;
    },
  };
  const cli = createCliBackend({
    runner: recording,
    command: process.execPath,
    prefixArgs: [FAKE_CLAUDE],
    allowedTools: [],
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", ...scenarioEnv },
    logger,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
  });
  return { cli, specs, pids };
}

async function collect(stream: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function rejectionCode(promise: Promise<unknown>): Promise<ErrorCode> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

const signal = () => new AbortController().signal;

describe("CliBackend.stream", () => {
  it(
    "emits start, the text deltas and exactly one final result for a successful run",
    async () => {
      const { cli } = setup(replay("success.ndjson"));
      const events = await collect(cli.stream(request(), signal()));
      expect(events[0]).toEqual({ type: "start", model: "claude-haiku-4-5-20251001" });
      expect(events.map((e) => (e.type === "delta" ? e.text : "")).join("")).toBe("pong");
      expect(events.filter((e) => e.type === "result")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "result",
        result: { text: "pong", stopReason: "end_turn" },
      });
    },
    T,
  );

  it(
    "spawns the CLI with the locked-down args, the prompt on stdin and the given env",
    async () => {
      const { cli, specs } = setup(replay("success.ndjson"));
      const req = request({ model: "haiku", systemPrompt: "be brief", timeoutMs: 12_345 });
      await collect(cli.stream(req, signal()));
      expect(specs).toHaveLength(1);
      const spec = specs[0] as RunSpec;
      expect(spec.command).toBe(process.execPath);
      expect(spec.args).toEqual([FAKE_CLAUDE, ...buildArgs(req, { allowedTools: [] })]);
      expect(spec.stdin).toBe(req.prompt);
      expect(spec.timeoutMs).toBe(12_345);
      expect(spec.env).toMatchObject({ FAKE_CLAUDE_SCENARIO: "replay" });
    },
    T,
  );

  it(
    "returns structured output when a schema was requested",
    async () => {
      const { cli } = setup(replay("schema.ndjson"));
      const result = await cli.run(
        request({ jsonSchema: { type: "object", properties: { answer: { type: "string" } } } }),
        signal(),
      );
      expect(result.structuredOutput).toEqual({ answer: "The capital of France is Paris." });
    },
    T,
  );

  it(
    "fails with cli_failed when a schema was requested but no structured output came back",
    async () => {
      const { cli } = setup(replay("success.ndjson"));
      const run = cli.run(request({ jsonSchema: { type: "object" } }), signal());
      expect(await rejectionCode(run)).toBe("cli_failed");
    },
    T,
  );

  it.each<[string, Record<string, string>, ErrorCode]>([
    ["the real logged-out run", replay("logged-out.ndjson", 1), "cli_not_authenticated"],
    [
      "the real unknown-flag failure",
      replay(undefined, 1, "bad-flag.stderr.txt"),
      "cli_incompatible",
    ],
    ["a clean exit with no output", replay(undefined, 0), "cli_protocol_error"],
  ])(
    "maps %s to %s",
    async (_name, env, code) => {
      const { cli } = setup(env);
      expect(await rejectionCode(collect(cli.stream(request(), signal())))).toBe(code);
    },
    T,
  );

  it(
    "reports a timeout, not a protocol error, when the kill truncated the output",
    async () => {
      const clock = new FakeClock();
      const { cli, pids } = setup({ FAKE_CLAUDE_SCENARIO: "garbage-then-hang" }, { clock });
      const done = rejectionCode(collect(cli.stream(request({ timeoutMs: 5000 }), signal())));
      await new Promise((resolve) => setTimeout(resolve, 400)); // let the garbage arrive
      clock.advance(5000);
      expect(await done).toBe("timeout");
      await waitForDeath(pids[0] as number);
    },
    T,
  );

  it(
    "kills the process when the consumer stops early",
    async () => {
      const { cli, pids } = setup({ FAKE_CLAUDE_SCENARIO: "init-then-hang" });
      for await (const event of cli.stream(request(), signal())) {
        expect(event).toEqual({ type: "start", model: "fake-model" });
        break;
      }
      await waitForDeath(pids[0] as number);
    },
    T,
  );

  it(
    "kills the process and rejects when the signal aborts",
    async () => {
      const { cli, pids } = setup({ FAKE_CLAUDE_SCENARIO: "init-then-hang" });
      const controller = new AbortController();
      const stream = cli.stream(request(), controller.signal);
      expect((await stream.next()).value).toEqual({ type: "start", model: "fake-model" });
      expect(isAlive(pids[0] as number)).toBe(true);
      controller.abort();
      expect(await rejectionCode(collect(stream))).toBe("cancelled");
      await waitForDeath(pids[0] as number);
    },
    T,
  );
});

describe("CliBackend.stream when cancelled or broken", () => {
  it("does not spawn anything when the signal is already aborted", async () => {
    const { cli, specs } = setup(replay("success.ndjson"));
    expect(await rejectionCode(collect(cli.stream(request(), AbortSignal.abort())))).toBe(
      "cancelled",
    );
    expect(specs).toHaveLength(0);
  });

  it(
    "reports a cancelled run as cancelled even if its output was garbled",
    async () => {
      const { cli, pids } = setup({ FAKE_CLAUDE_SCENARIO: "garbage-then-hang" });
      const controller = new AbortController();
      const done = rejectionCode(collect(cli.stream(request(), controller.signal)));
      await new Promise((resolve) => setTimeout(resolve, 400)); // let the garbage arrive
      controller.abort();
      expect(await done).toBe("cancelled");
      await waitForDeath(pids[0] as number);
    },
    T,
  );

  it("turns a non-AppError from the output stream into cli_failed", async () => {
    const { logger } = makeRunner();
    const broken: ProcessRunner = {
      async start() {
        return {
          pid: 0,
          stdout: (async function* () {
            yield* [];
            throw new Error("stdout cut off: C:\\Users\\me\\secret");
          })(),
          exit: Promise.resolve({
            code: 0,
            killReason: undefined,
            stderrTail: "",
            durationMs: 1,
          }),
          kill: async () => {},
        };
      },
    };
    const cli = createCliBackend({
      runner: broken,
      command: "unused",
      allowedTools: [],
      env: {},
      logger,
    });
    const error = await collect(cli.stream(request(), signal())).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("cli_failed");
    expect((error as AppError).message).not.toContain("secret");
  });
});

describe("CliBackend.probe", () => {
  it("shares one probe between concurrent callers", async () => {
    let calls = 0;
    const exec: ExecCli = async (args) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return args.includes("--version")
        ? "2.1.287 (Claude Code)\n"
        : JSON.stringify({ loggedIn: true });
    };
    const { cli } = setup({}, { exec });
    const statuses = await Promise.all([cli.probe(), cli.probe(), cli.probe()]);
    expect(calls).toBe(2);
    expect(statuses.every((status) => status.ready)).toBe(true);
  });

  it(
    "is ready when the version is supported and the CLI is logged in",
    async () => {
      const { cli } = setup({});
      expect(await cli.probe()).toEqual({ ready: true, loggedIn: true, version: "2.1.287" });
    },
    T,
  );

  it(
    "is not ready when the CLI is logged out",
    async () => {
      const { cli } = setup({ FAKE_CLAUDE_LOGGED_IN: "false" });
      expect(await cli.probe()).toMatchObject({
        ready: false,
        loggedIn: false,
        version: "2.1.287",
      });
    },
    T,
  );

  it(
    "is not ready when the CLI is too old",
    async () => {
      const { cli } = setup({ FAKE_CLAUDE_VERSION: "2.1.200 (Claude Code)" });
      const status = await cli.probe();
      expect(status).toMatchObject({ ready: false, version: "2.1.200" });
      expect(status.reason).toContain("2.1.259");
    },
    T,
  );

  it("is not ready when the CLI cannot be run", async () => {
    const exec: ExecCli = async () => {
      throw new Error("spawn ENOENT");
    };
    const { cli } = setup({}, { exec });
    expect(await cli.probe()).toMatchObject({ ready: false, loggedIn: false });
  });

  it("caches the status for 30 seconds", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const exec: ExecCli = async (args) => {
      calls++;
      return args.includes("--version")
        ? "2.1.287 (Claude Code)\n"
        : JSON.stringify({ loggedIn: true });
    };
    const { cli } = setup({}, { clock, exec });
    await cli.probe();
    const afterFirst = calls;
    clock.advance(29_000);
    await cli.probe();
    expect(calls).toBe(afterFirst);
    clock.advance(2_000);
    await cli.probe();
    expect(calls).toBe(afterFirst * 2);
  });
});
