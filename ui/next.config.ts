import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['pdf-parse'],
  // Разрешаем dev-сервер с других хостов в локальной сети:
  // без этого Next.js 16 блокирует HMR-WebSocket для не-localhost,
  // что ломает гидрацию React (форма логина не работает).
  allowedDevOrigins: [
    '192.168.1.113',
    '192.168.1.*',
    '10.0.0.*',
    '10.66.0.*',
    'WINTIGRA',
    'wintigra',
  ],
};

export default nextConfig;
