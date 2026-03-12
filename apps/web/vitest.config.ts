import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          r2Buckets: ["BUCKET"],
          bindings: {
            R2_ACCESS_KEY_ID: "test-access-key",
            R2_SECRET_ACCESS_KEY: "test-secret-key",
            R2_ACCOUNT_ID: "test-account-id",
          },
        },
      },
    },
  },
});
