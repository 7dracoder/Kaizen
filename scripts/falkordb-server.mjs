// Runs FalkorDB locally without Docker: redis-server with the FalkorDB module, data persisted in .data/falkordb.
//   npm run db                      (port 6379; FALKORDB_PORT to change)
// Needs redis-server on PATH (macOS: `brew install redis`). The FalkorDB module itself is downloaded once by the
// falkordblite package (official FalkorDB build) during `npm install`.
// Ctrl+C stops it; data is kept (append-only file), so the next start has the same memory.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";

const root = dirname(dirname(new URL(import.meta.url).pathname));
const port = process.env.FALKORDB_PORT || "6379";
const dataDir = join(root, ".data", "falkordb");
mkdirSync(dataDir, { recursive: true });

function findRedis() {
  try {
    return execFileSync("which", ["redis-server"], { encoding: "utf8" }).trim();
  } catch {
    console.error("redis-server not found. macOS: brew install redis. Linux: apt install redis-server. Or use Docker: docker run -p 6379:6379 falkordb/falkordb");
    process.exit(1);
  }
}

async function findModule() {
  if (process.env.FALKORDB_MODULE) return process.env.FALKORDB_MODULE;
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve("falkordblite/package.json"));
  const plat = `${platform()}-${arch()}`;
  const candidate = join(pkgDir, "bin", plat, "falkordb.so");
  if (existsSync(candidate)) return candidate;
  // Not downloaded yet (install ran offline): let falkordblite fetch the official build.
  const { BinaryManager } = require("falkordblite");
  const paths = await new BinaryManager().ensureBinaries();
  return paths.falkordbModulePath;
}

const redis = findRedis();
const module = await findModule();
console.log(`FalkorDB on 127.0.0.1:${port}, data in ${dataDir}`);
const child = spawn(
  redis,
  ["--loadmodule", module, "--port", port, "--bind", "127.0.0.1", "--dir", dataDir, "--appendonly", "yes", "--save", "60 1", "--protected-mode", "yes"],
  { stdio: "inherit" },
);
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
