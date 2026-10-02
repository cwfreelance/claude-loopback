// Manual end-to-end check against a running server and the REAL Claude CLI. Spends a little
// subscription usage (a handful of short haiku calls), so it never runs in CI.
//
//   pnpm start            # in one terminal (reads .env)
//   pnpm run e2e          # in another (reads the same .env)

const token = process.env.LOOPBACK_TOKEN;
if (!token) {
  console.error("claude-loopback e2e: set LOOPBACK_TOKEN (e.g. in .env)");
  process.exit(1);
}
// E2E_URL, not LOOPBACK_URL: the server rejects unknown LOOPBACK_* settings in a shared .env.
const port = process.env.LOOPBACK_PORT ?? "7337";
if (process.env.E2E_URL === undefined && port === "0") {
  console.error(
    "claude-loopback e2e: LOOPBACK_PORT is 0 (ephemeral); set E2E_URL to the server's address",
  );
  process.exit(1);
}
const base = process.env.E2E_URL ?? `http://127.0.0.1:${port}`;
// The token is sent with every request: refuse anything but this machine.
const target = new URL(base);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)) {
  console.error(
    `claude-loopback e2e: refusing to send the token to ${target.origin}; only loopback is allowed`,
  );
  process.exit(1);
}
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const cheap = { model: "haiku", effort: "low" } as const;

type Json = Record<string, unknown>;
let failures = 0;

async function step(name: string, check: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await check();
    console.log(`  ok   ${name} (${Date.now() - started} ms)${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function post(path: string, body: Json, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), ...init });
}

async function prompt(body: Json): Promise<Json> {
  const response = await post("/v1/prompt", { ...cheap, ...body });
  const json = (await response.json()) as Json;
  assert(response.ok, `HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function readyQueue(): Promise<{ active: number; waiting: number }> {
  const response = await fetch(`${base}/ready`, { headers });
  return ((await response.json()) as { queue: { active: number; waiting: number } }).queue;
}

console.log(`claude-loopback e2e against ${base}`);

await step("GET /health", async () => {
  const response = await fetch(`${base}/health`);
  assert(response.ok, `HTTP ${response.status}`);
  return "";
});

await step("GET /ready", async () => {
  const response = await fetch(`${base}/ready`, { headers });
  const body = (await response.json()) as { ready: boolean; cli: Json };
  assert(body.ready, `not ready: ${JSON.stringify(body.cli)}`);
  return `CLI ${String(body.cli.version)}`;
});

await step("POST /v1/prompt", async () => {
  const body = await prompt({ prompt: "Reply with exactly the word: pong" });
  assert(String(body.text).toLowerCase().includes("pong"), `unexpected text: ${String(body.text)}`);
  return `${String(body.model)}, $${String(body.costUsd)}`;
});

await step("POST /v1/prompt with jsonSchema", async () => {
  const body = await prompt({
    prompt: "What is the capital of France?",
    jsonSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  });
  const answer = (body.structuredOutput as { answer?: string } | undefined)?.answer;
  assert(answer?.toLowerCase().includes("paris"), `unexpected output: ${JSON.stringify(body)}`);
  return `answer: ${answer}`;
});

await step("POST /v1/prompt with an attachment", async () => {
  const body = await prompt({
    prompt: "What is the secret word in the attached file? Reply with just the word.",
    attachments: [{ name: "secret.txt", content: "The secret word is zebra." }],
  });
  assert(
    String(body.text).toLowerCase().includes("zebra"),
    `unexpected text: ${String(body.text)}`,
  );
  return "";
});

await step("POST /v1/prompt/stream", async () => {
  const response = await post("/v1/prompt/stream", {
    ...cheap,
    prompt: "Count from 1 to 5, separated by spaces.",
  });
  assert(response.ok, `HTTP ${response.status}`);
  const text = await response.text();
  const events = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
  assert(events[0] === "start", `first event: ${events[0]}`);
  assert(events.includes("delta"), "no delta events");
  assert(events.at(-1) === "result", `last event: ${events.at(-1)}`);
  return `${events.filter((event) => event === "delta").length} deltas`;
});

await step("client disconnect mid-stream frees the slot", async () => {
  const controller = new AbortController();
  const response = await post(
    "/v1/prompt/stream",
    { ...cheap, prompt: "Write a 300-word story about a lighthouse." },
    { signal: controller.signal },
  );
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("event: start")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  const deadline = Date.now() + 10_000;
  for (let queue = await readyQueue(); queue.active > 0; queue = await readyQueue()) {
    assert(Date.now() < deadline, "slot still busy after 10 s");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return "";
});

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
