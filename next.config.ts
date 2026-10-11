import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite (in-process Postgres used when DATABASE_URL is unset) ships wasm and
  // Node-specific loaders; keep it out of the server bundle.
  // @getdial/sdk reads its own package.json via __dirname at load time, which breaks when bundled.
  serverExternalPackages: ["@electric-sql/pglite", "@getdial/sdk"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
