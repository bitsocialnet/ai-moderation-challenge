import * as esbuild from "esbuild";

await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/index.js",
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    external: ["@pkcprotocol/pkc-js", "@pkcprotocol/pkc-logger", "@noble/ed25519", "cborg", "uint8arrays", "zod"]
});

console.log("Build complete");
