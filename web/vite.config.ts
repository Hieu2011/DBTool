import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // `dotnet run -- --dev` serves the API on 5280
    proxy: { '/api': 'http://127.0.0.1:5280' },
  },
  build: {
    outDir: '../src/DbStudio.Host/wwwroot',
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000, // monaco is big; it's a local app
  },
});
