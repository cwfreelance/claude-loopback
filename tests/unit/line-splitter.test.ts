import { describe, expect, it } from "vitest";
import { splitLines } from "../../src/backends/cli/stream-parser.ts";
import { AppError } from "../../src/errors.ts";
import { fixture, fromArray } from "../helpers/streams.ts";

async function lines(chunks: Buffer[], maxLineLength?: number): Promise<string[]> {
  const out: string[] = [];
  const options = maxLineLength === undefined ? {} : { maxLineLength };
  for await (const line of splitLines(fromArray(chunks), options)) out.push(line);
  return out;
}

const buf = (text: string) => Buffer.from(text, "utf8");

describe("splitLines", () => {
  it("splits on newlines and drops empty lines", async () => {
    expect(await lines([buf('{"a":1}\n\n{"b":2}\n')])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles CRLF line endings", async () => {
    expect(await lines([buf('{"a":1}\r\n{"b":2}\r\n')])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("yields a final line that has no trailing newline", async () => {
    expect(await lines([buf('{"a":1}\n{"b":2}')])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("joins a line split across many chunks", async () => {
    expect(await lines([buf('{"te'), buf('xt":"he'), buf('llo"}\n')])).toEqual([
      '{"text":"hello"}',
    ]);
  });

  it("gives identical lines for every split point, including inside multibyte characters", async () => {
    const text = [
      JSON.stringify({ type: "delta", text: "héllo wörld ✓ — 日本語 😀🎉" }),
      JSON.stringify({ type: "delta", text: "second 🚀 line with é and ß" }),
      JSON.stringify({ type: "result", result: "Ünïcödé 終わり" }),
    ].join("\n");
    const bytes = buf(`${text}\n`);
    const expected = text.split("\n");
    for (let at = 0; at <= bytes.length; at++) {
      const got = await lines([bytes.subarray(0, at), bytes.subarray(at)]);
      expect(got, `split at byte ${at}`).toEqual(expected);
    }
  });

  it("gives identical lines for a real capture split into odd-sized chunks", async () => {
    const bytes = buf(fixture("schema.ndjson"));
    const expected = fixture("schema.ndjson").split("\n").filter(Boolean);
    for (const size of [1, 2, 3, 7, 64, 1000]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
      expect(await lines(chunks), `chunk size ${size}`).toEqual(expected);
    }
  });

  it("fails with cli_protocol_error when a line exceeds the limit", async () => {
    const error = await lines([buf("x".repeat(50)), buf("y".repeat(60))], 100).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("cli_protocol_error");
  });

  it("allows a line exactly at the limit", async () => {
    expect(await lines([buf(`${"x".repeat(100)}\n`)], 100)).toEqual(["x".repeat(100)]);
  });
});
