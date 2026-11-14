import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';

function copyClassicScriptPlugin() {
  return {
    name: 'copy-frontend-script',
    closeBundle() {
      const src = path.resolve(__dirname, 'frontend', 'script.js');
      const dest = path.resolve(__dirname, 'dist', 'script.js');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    },
  };
}

export default defineConfig(() => {
  return {
    root: path.resolve(__dirname, 'frontend'),
    publicDir: path.resolve(__dirname, 'public'),
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
    },
    plugins: [copyClassicScriptPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
