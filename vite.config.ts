import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Explicit, not inherited: production source maps would publish the whole tree
  // to anyone with devtools once this repo and deploy go public (SOUS_PLAN.md §12.2).
  build: { sourcemap: false },
})
