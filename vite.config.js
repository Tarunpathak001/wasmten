import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: {
        enabled: true,
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,data,py,zip,whl,json,svg,ttf}'],
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024, // 50MB
      },
      manifest: {
        name: 'WasmForge',
        short_name: 'WasmForge',
        description: 'Your entire dev environment. One browser tab. Zero servers.',
        theme_color: '#1a252f',
        background_color: '#1a252f',
        display: 'standalone',
      }
    })
  ],

  server: {
    headers: {

      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',

    }
  },


  worker: {
    format: 'es'
  },

  optimizeDeps: {
    exclude: ['@monaco-editor/react']
  }
})
