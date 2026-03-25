import { defineConfig } from 'vite';
import { resolve, join, dirname } from 'path';
import { readFileSync, existsSync } from 'fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Resolve @zerolimit/packages subpath exports manually.
 *
 * npm install --install-links copies git deps rather than symlinking, which
 * can break Node's package "exports" map resolution depending on npm version.
 * This plugin reads the package.json exports field and resolves subpath
 * imports directly.
 */
function zerolimitResolver() {
  const PKG = '@zerolimit/packages';
  let exportsMap = null;
  let pkgDir = null;

  return {
    name: 'zerolimit-resolver',
    resolveId(id) {
      if (!id.startsWith(PKG + '/')) return null;
      const subpath = './' + id.slice(PKG.length + 1); // e.g. "./solid-auth/react"

      if (!exportsMap) {
        pkgDir = resolve(__dirname, 'node_modules', PKG);
        try {
          const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
          exportsMap = pkg.exports || {};
        } catch {
          return null;
        }
      }

      const target = exportsMap[subpath];
      if (target) {
        const resolved = resolve(pkgDir, target);
        if (existsSync(resolved)) return resolved;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    zerolimitResolver(),
    tailwindcss(),
    react({
      include: [
        'src/**/*.jsx',
        '../packages/solid-auth/src/react/**/*.jsx',
        '../packages/passkey-mfa/src/react/**/*.jsx',
        // --install-links copies git deps into node_modules instead of symlinking
        'node_modules/@zerolimit/packages/packages/*/src/**/*.jsx',
      ],
    }),
  ],
  resolve: {
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})