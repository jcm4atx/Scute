import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, cp, mkdir, writeFile } from "node:fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Scute's own share viewers: one self-contained HTML file each
  console.log("building share viewers...");
  await mkdir("dist/viewers", { recursive: true });
  for (const name of ["saved-copy"]) {
    const js = await esbuild({ entryPoints: [`client/src/share/${name}.ts`], bundle: true, format: "iife", target: "es2020", minify: true, write: false, logLevel: "warning" });
    const html = (await readFile(`client/src/share/${name}.html`, "utf-8")).replace("/*SCRIPT*/", () => js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"));
    await writeFile(`dist/viewers/${name}.html`, html);
  }

  // bundled example plug-ins (served read-only, off until an admin enables them)
  await cp("plugins", "dist/plugins", { recursive: true });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
