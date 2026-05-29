import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default {
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [
    tailwindcss(),
    basicSsl(),
  ],
};
