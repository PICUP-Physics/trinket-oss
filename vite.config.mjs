import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Build CSS assets only (Hapi serves the app)
  build: {
    outDir: 'public',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        base: resolve(__dirname, 'static/scss/base.scss'),
        embed: resolve(__dirname, 'static/scss/embed/embed.scss'),
      },
      output: {
        assetFileNames: (assetInfo) => {
          // Output CSS files to css/ directory
          if (assetInfo.name.endsWith('.css')) {
            return 'css/[name].css';
          }
          return 'assets/[name].[ext]';
        },
      },
    },
    cssCodeSplit: true,
    sourcemap: true,
  },
  css: {
    preprocessorOptions: {
      scss: {
        loadPaths: ['.'],
      },
    },
  },
});
