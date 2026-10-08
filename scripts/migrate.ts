import { spawnSync } from "node:child_process";

/**
 * `pnpm db:migrate [--name <migration>]`
 *
 * Wraps `prisma migrate dev` so that (a) extra arguments reach the migrate
 * command and (b) the Prisma client is regenerated afterwards — Prisma 7 no
 * longer regenerates implicitly.
 */
function run(args: string[]): void {
  const result = spawnSync(["prisma", ...args].join(" "), {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["migrate", "dev", ...process.argv.slice(2)]);
run(["generate"]);
