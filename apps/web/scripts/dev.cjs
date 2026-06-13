"use strict";

/**
 * Next dev launcher for Windows + npm workspaces:
 * - Avoids cross-env (some shells report "cannot execute program")
 * - Raises V8 heap to reduce OOM on small-RAM machines
 * - Workarounds for SWC lockfile patch calling npm in workspace mode (ENOWORKSPACES)
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const appRoot = path.join(__dirname, "..");

const nextPkg = require.resolve("next/package.json", { paths: [appRoot] });
const nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");

if (!fs.existsSync(nextBin)) {
  console.error("Cannot find Next.js binary at:", nextBin);
  process.exit(1);
}

const nodeArgs = [
  "--max-old-space-size=8192",
  nextBin,
  "dev",
  "--webpack",
];

const env = {
  ...process.env,
  // Next 16: reduce broken lockfile / registry probing in npm workspaces (see Next.js #47121 / #68522)
  NEXT_IGNORE_INCORRECT_LOCKFILE: "1",
  NPM_CONFIG_WORKSPACES: "false",
  NEXT_TELEMETRY_DISABLED: "1",
};

const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  cwd: appRoot,
  env,
});

child.on("exit", (code) => process.exit(code === null ? 1 : code));
