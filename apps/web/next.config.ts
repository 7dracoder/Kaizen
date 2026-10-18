import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No floating dev badge over the 3D view (it shows up in recordings).
  devIndicators: false,
  // The graph client opens TCP connections to FalkorDB: keep it a plain Node dependency, never bundled.
  serverExternalPackages: ["falkordb", "@kaizen/graph"],
  // /live became /system when it was narrowed to the system index.
  async redirects() {
    return [{ source: "/live", destination: "/system", permanent: false }];
  },
};

export default nextConfig;
