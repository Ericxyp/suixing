import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const bffOrigin = process.env.SUIXING_BFF_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': bffOrigin, '/_AMapService': bffOrigin } },
});
