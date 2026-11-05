import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_VERSION, profile } from "./config.mjs";

const role = process.argv[2];
const settings = profile(process.env, role);
const source = dirname(fileURLToPath(import.meta.url));
const destination = resolve(".preprod-auth");
await mkdir(destination, { recursive: true });
for (const name of ["config.mjs", "gateway.mjs", "launch.mjs"])
  await copyFile(join(source, name), join(destination, name));
await writeFile(join(destination, "role"), `${role}\n`);
await writeFile(
  join(destination, "build.json"),
  JSON.stringify({ enabled: settings.enabled, version: GATEWAY_VERSION }) +
    "\n",
);
console.log(
  `Native preproduction gateway prepared (enabled: ${settings.enabled}).`,
);
