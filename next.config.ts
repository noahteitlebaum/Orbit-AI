import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-only "N" badge would sit on top of the account button in the bottom-left corner.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
