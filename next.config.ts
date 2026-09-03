import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: an unrelated package-lock.json in the parent
  // directory tree otherwise makes Turbopack misdetect it as the root.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
