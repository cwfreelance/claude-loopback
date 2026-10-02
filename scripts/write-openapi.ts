// Regenerates docs/openapi.json from the Zod schemas: `pnpm run openapi`.
import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "../src/http/openapi.ts";

const target = new URL("../docs/openapi.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log("wrote docs/openapi.json");
