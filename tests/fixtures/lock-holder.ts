// Holds the instance lock for a work root until killed. Run with `node lock-holder.ts <work-root>`.
import { acquireInstanceLock } from "../../src/process/instance-lock.ts";

const workRoot = process.argv[2];
if (!workRoot) throw new Error("usage: lock-holder.ts <work-root>");
await acquireInstanceLock(workRoot);
process.stdout.write("locked\n");
setInterval(() => {}, 1 << 30);
