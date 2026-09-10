import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
export default defineConfig({ plugins: [react()], base: './', define: { 'process.env.NODE_ENV': '"production"' }, build: {
  minify: 'esbuild', target: 'es2022',
  outDir: path.resolve('out/online-workspace'), emptyOutDir: true,
  lib: { entry: path.resolve('src/renderer/src/online-workspace.tsx'), formats: ['es'], fileName: () => 'online-workspace.js' },
  rollupOptions: { output: { assetFileNames: 'assets/[name]-[hash][extname]' } }
} })
