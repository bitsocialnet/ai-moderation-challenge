import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // These developer helpers run with node:test in the separate CI step.
        exclude: [...configDefaults.exclude, "scripts/jev/tests/**"],
        coverage: {
            provider: "v8",
            reporter: ["text", "json-summary"],
            reportsDirectory: "./coverage",
            include: ["src/**/*.ts"]
        }
    }
});
