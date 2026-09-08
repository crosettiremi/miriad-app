import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Default backend URL for local development
const BACKEND_URL = process.env.VITE_BACKEND_URL ?? ''

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    // /assets belongs to the backend API on the shared production origin.
    assetsDir: 'static',
  },
  // Define backend URL as compile-time constant - single source of truth
  define: {
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify(BACKEND_URL),
  },
  server: {
    port: 5174, // Use non-default port to avoid conflicts
    allowedHosts: true, // Allow all hosts (for VPN/Tailscale access)
    // No proxy - all API/WS calls go direct to backend via API_HOST
  },
}))
