// Orbit Helper downloads (the desktop app that gives the AI access to one folder; source: public/helper/orbit-helper.mjs).
// Build them with `npm run build:helper` (writes public/downloads/). To host them elsewhere (e.g. GitHub Releases,
// recommended: they're ~60 MB each), set these env vars to the full URLs.
export const HELPER_DOWNLOADS = {
  windows: process.env.NEXT_PUBLIC_HELPER_WINDOWS_URL || "/downloads/OrbitHelper-Windows.exe",
  macArm: process.env.NEXT_PUBLIC_HELPER_MAC_ARM_URL || "/downloads/OrbitHelper-Mac-AppleSilicon.zip",
  macIntel: process.env.NEXT_PUBLIC_HELPER_MAC_INTEL_URL || "/downloads/OrbitHelper-Mac-Intel.zip",
};
