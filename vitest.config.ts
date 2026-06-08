import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  // the preact preset provides the react->preact/compat aliases and the JSX
  // transform that src/ relies on (App.tsx & hooks.ts import from "react").
  plugins: [preact()],
  test: {
    // worker tests run in node (node:sqlite); src/DOM tests opt into happy-dom
    // per-file via a `// @vitest-environment happy-dom` docblock.
    environment: "node",
    include: ["test/**/*.spec.ts", "test/**/*.spec.tsx"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**", "worker/**"],
      // main.tsx is the render bootstrap (no logic); styles aren't code.
      exclude: ["src/main.tsx", "src/**/*.css"],
      reporter: ["text", "html"],
      // CI gate: every metric must stay at/above 95%. `npm run test:coverage`
      // (and CI) fail the build if any drops below.
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 95,
      },
    },
  },
});
