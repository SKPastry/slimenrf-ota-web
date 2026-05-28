import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default {
  clearScreen: false,
  server: {
    port: isTauri ? 1420 : 5173,
    strictPort: true,
  },
  plugins: [
    tailwindcss(),
    !isTauri && basicSsl(),
  ].filter(Boolean),
};
