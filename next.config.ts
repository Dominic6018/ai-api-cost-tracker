import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker build sets NEXT_OUTPUT=standalone to produce a self-contained
  // server; `npm start` needs the default output, so it stays opt-in.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Next 16's `next dev` otherwise writes an AGENTS.md of instructions for
  // AI coding tools into the repository root on every start.
  agentRules: false,
};

export default nextConfig;
