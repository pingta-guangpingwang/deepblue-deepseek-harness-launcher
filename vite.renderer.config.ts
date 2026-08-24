import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: path.resolve('src/renderer'),
  // The same renderer is loaded from both the packaged kernel and a downloaded
  // launcher-ui module. Relative asset URLs keep both file:// roots portable.
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve('out/renderer'),
    emptyOutDir: true
  },
  server: { host: '127.0.0.1', port: 4312, strictPort: true }
})
