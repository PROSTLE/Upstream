// Runs the API server (with --watch) and the Vite dev server together.
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "dev", "-w", "server"], { stdio: "inherit", shell: true }),
  spawn("npm", ["run", "dev", "-w", "web"], { stdio: "inherit", shell: true }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => code && code !== 0 && stop()));
