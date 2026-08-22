import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: path.resolve('src/renderer'),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4312, strictPort: true }
})
