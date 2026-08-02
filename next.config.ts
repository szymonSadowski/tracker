import type { NextConfig } from 'next';

const config: NextConfig = {
  // `pg` must stay a real Node dependency of the server runtime, not be bundled.
  serverExternalPackages: ['pg'],
  experimental: {
    typedRoutes: false,
  },
};

export default config;
