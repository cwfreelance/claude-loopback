import { readFileSync } from "node:fs";

/** This package's version, read from package.json (one level above both src/ and dist/). */
export function packageVersion(): string {
  const file = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}
