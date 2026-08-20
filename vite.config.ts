import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' — относительные пути к ассетам, чтобы сборка работала
// и на GitHub Pages в подкаталоге (https://user.github.io/password/), и на своём домене.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '0.0.0.0' },
  preview: { host: '0.0.0.0' }
})
