import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@lancedb/lancedb', 'pino', 'rotating-file-stream'],
  webpack: (config, { isServer }) => {
    // Resolve .js imports to .ts (parent code uses ESM .js extensions)
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };

    // Exclude native modules from bundling (parent's node_modules)
    if (isServer) {
      config.externals = config.externals || [];
      const externals = Array.isArray(config.externals) ? config.externals : [config.externals];
      externals.push({
        '@lancedb/lancedb': 'commonjs @lancedb/lancedb',
        pino: 'commonjs pino',
        'rotating-file-stream': 'commonjs rotating-file-stream',
      });
      config.externals = externals;
    }

    return config;
  },
};

export default nextConfig;
