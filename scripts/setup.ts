// First-time setup from a clone: `pnpm run setup`. Creates or fills .env (from .env.example)
// and checks this machine; see runSetup. `--skip-checks` only does the .env part (tests use it:
// they never run the real CLI).
import { existsSync, readFileSync } from "node:fs";
import { runSetup } from "../src/setup.ts";

const problems = await runSetup({
  file: ".env",
  template: existsSync(".env.example") ? readFileSync(".env.example", "utf8") : "LOOPBACK_TOKEN=\n",
  label: ".env",
  rerun: "pnpm run setup",
  next: "pnpm run build, then pnpm start",
  skipChecks: process.argv.includes("--skip-checks"),
  warnOutsideProfile: true,
  env: process.env,
});
process.exit(problems === 0 ? 0 : 1);
