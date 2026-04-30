import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Cada build gera nomes de arquivo unicos pra invalidar cache do navegador
const buildTimestamp = Date.now()

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  },
  build: {
    rollupOptions: {
      output: {
        // Adiciona timestamp ao hash dos chunks pra forcar invalidacao
        entryFileNames: `assets/[name]-[hash]-${buildTimestamp}.js`,
        chunkFileNames: `assets/[name]-[hash]-${buildTimestamp}.js`,
        assetFileNames: `assets/[name]-[hash]-${buildTimestamp}[extname]`,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3010',
      '/ws': {
        target: 'ws://localhost:3010',
        ws: true,
      },
    },
  },
})
