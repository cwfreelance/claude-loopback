import { readFileSync } from "node:fs";

const FIXTURES = new URL("../fixtures/streams/", import.meta.url);

/** Raw text of a captured fixture under tests/fixtures/streams. */
export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

export function fixtureLines(name: string): string[] {
  return fixture(name).split("\n").filter(Boolean);
}

export async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/** Drains a generator, returning what it yielded and what it returned. */
export async function drain<T, R>(
  generator: AsyncGenerator<T, R>,
): Promise<{ items: T[]; returned: R }> {
  const items: T[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { items, returned: next.value };
    items.push(next.value);
  }
}
