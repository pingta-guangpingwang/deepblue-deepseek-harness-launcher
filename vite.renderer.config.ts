import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { createReadStream } from 'node:fs'

export default defineConfig({
  root: path.resolve('src/renderer'),
  plugins: [
    react(),
    {
      name: 'pet-preview-development-assets',
      configureServer(server) {
        server.middlewares.use('/__pet-preview', (request, response, next) => {
          const filename = path.basename(new URL(request.url || '/', 'http://localhost').pathname)
          if (!filename.endsWith('.webp')) return next()
          response.setHeader('Content-Type', 'image/webp')
          createReadStream(path.resolve('pet-store', 'thumbnails', filename)).on('error', next).pipe(response)
        })
      }
    }
  ],
  server: { host: '127.0.0.1', port: 4312, strictPort: true }
})
