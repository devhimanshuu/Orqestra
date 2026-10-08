import { defineConfig, env } from "prisma/config";
import { loadEnvFile } from "node:process";

// Prisma 7 does not load `.env` automatically when a config file is present.
try {
  loadEnvFile();
} catch {
  // No .env file — commands that need env vars will report missing variables.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
