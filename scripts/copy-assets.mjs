import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist/admin"), { recursive: true });
await cp(resolve(root, "src/admin/admin.html"), resolve(root, "dist/admin/admin.html"));
console.log("copied admin.html -> dist/admin/");
