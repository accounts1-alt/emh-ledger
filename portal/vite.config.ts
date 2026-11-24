import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path is passed on the command line in CI: --base=/semtek-portal/
export default defineConfig({ plugins: [react()] });
