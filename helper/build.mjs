// Builds the Orbit Helper download apps from public/helper/orbit-helper.mjs (no Node.js needed by students):
//   public/downloads/OrbitHelper-Windows.exe
//   public/downloads/OrbitHelper-Mac-AppleSilicon.zip   (OrbitHelper.app, ad-hoc signed)
//   public/downloads/OrbitHelper-Mac-Intel.zip
//
//   npm run build:helper
//
// Uses esbuild + @yao-pkg/pkg (fetched with npx). Mac apps must be signed to run on Apple Silicon: this uses macOS
// `codesign` when building on a Mac, otherwise `rcodesign` (github.com/indygreg/apple-platform-rs) if it's on PATH.
// Unsigned/un-notarized apps still show a security prompt the first time; a paid Apple Developer ID + notarization
// (and a Windows code-signing certificate) removes those prompts.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".helper-build");
const out = path.join(root, "public", "downloads");
const version = /VERSION = "([^"]+)"/.exec(readFileSync(path.join(root, "public/helper/orbit-helper.mjs"), "utf8"))[1];
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: work, shell: process.platform === "win32", ...opts });
const has = (cmd) => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Zip a .app keeping Unix permissions (python's zipfile, so this works without a zip tool).
const ZIP_PY = `
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
base = os.path.dirname(src)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(src):
        for name in sorted(dirs + files):
            full = os.path.join(d, name)
            info = zipfile.ZipInfo(os.path.relpath(full, base) + ("/" if os.path.isdir(full) else ""))
            info.external_attr = (os.stat(full).st_mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, b"" if os.path.isdir(full) else open(full, "rb").read())
`;

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

// 1. One CommonJS file (pkg handles CJS best).
sh("npx", ["--yes", "esbuild@0.25.10", path.join(root, "public/helper/orbit-helper.mjs"), "--bundle", "--platform=node", "--format=cjs", "--target=node22", "--outfile=helper.cjs"]);

// 2. Executables.
const targets = { "node22-win-x64": "win.exe", "node22-macos-arm64": "mac-arm64", "node22-macos-x64": "mac-x64" };
for (const [target, file] of Object.entries(targets)) {
  sh("npx", ["--yes", "@yao-pkg/pkg@6.23.0", "helper.cjs", "-t", target, "-o", file, "--no-bytecode", "--public-packages", "*", "--public"]);
}
cpSync(path.join(work, "win.exe"), path.join(out, "OrbitHelper-Windows.exe"));

// 3. Mac: wrap in OrbitHelper.app, sign (ad-hoc), zip (keeps the executable bit).
const signer = process.platform === "darwin" ? "codesign" : has("rcodesign") ? "rcodesign" : null;
if (!signer) console.warn("\n⚠  No codesign/rcodesign found: Mac apps are unsigned and won't open on Apple Silicon.\n");
for (const [file, label] of [["mac-arm64", "AppleSilicon"], ["mac-x64", "Intel"]]) {
  const app = path.join(work, label, "Orbit Helper.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  cpSync(path.join(work, file), path.join(app, "Contents", "MacOS", "OrbitHelper"));
  chmodSync(path.join(app, "Contents", "MacOS", "OrbitHelper"), 0o755);
  writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Orbit Helper</string>
<key>CFBundleIdentifier</key><string>ca.orbitai.helper</string>
<key>CFBundleExecutable</key><string>OrbitHelper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
`);
  if (signer === "codesign") sh("codesign", ["--force", "--deep", "--sign", "-", app]);
  else if (signer === "rcodesign") sh("rcodesign", ["sign", app]);
  const zip = path.join(out, `OrbitHelper-Mac-${label}.zip`);
  rmSync(zip, { force: true });
  if (process.platform === "darwin") sh("ditto", ["-c", "-k", "--keepParent", app, zip]);
  else sh("python3", ["-c", ZIP_PY, app, zip]);
}

rmSync(work, { recursive: true, force: true });
console.log(`\nOrbit Helper ${version} → ${path.relative(root, out)}/`);
