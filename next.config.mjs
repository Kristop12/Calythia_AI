/** @type {import('next').NextConfig} */
const nextConfig = {
  // Kokoro / Transformers.js run in the browser; keep Node bindings out of the bundle.
  serverExternalPackages: ["kokoro-js", "@huggingface/transformers"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      "onnxruntime-node$": false,
    };
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
