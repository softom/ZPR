#!/usr/bin/env node
/*
 * ЗПР migration — генератор .env для self-hosted Supabase на Beget.
 * Читает .env.example в текущей папке, подставляет свежие секреты и серверные URL,
 * пишет .env. Печатает в stdout только НЕсекретные значения (anon/url/порт).
 *
 * Запуск:  node gen-supabase-env.js  (в каталоге /opt/zpr/app/supabase)
 * Идемпотентность: если .env уже есть — НЕ перезаписывает (защита от потери ключей).
 *   Принудительно: FORCE=1 node gen-supabase-env.js
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const WG_IP = process.env.ZPR_WG_IP || '10.8.0.1';
const KONG_PORT = process.env.ZPR_KONG_PORT || '8000';
const UI_PORT = process.env.ZPR_UI_PORT || '3000';

const dir = process.cwd();
const examplePath = path.join(dir, '.env.example');
const outPath = path.join(dir, '.env');

if (fs.existsSync(outPath) && !process.env.FORCE) {
  console.error('.env уже существует — пропуск (FORCE=1 чтобы перезаписать).');
  process.exit(0);
}
if (!fs.existsSync(examplePath)) {
  console.error('Не найден .env.example в ' + dir);
  process.exit(1);
}

const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwtHS256(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

const JWT_SECRET = hex(24); // 48 hex chars (> 32)
const iat = Math.floor(Date.now() / 1000);
const exp = iat + 10 * 365 * 24 * 3600; // 10 лет
const ANON_KEY = jwtHS256({ role: 'anon', iss: 'supabase', iat, exp }, JWT_SECRET);
const SERVICE_ROLE_KEY = jwtHS256({ role: 'service_role', iss: 'supabase', iat, exp }, JWT_SECRET);

const overrides = {
  COMPOSE_FILE: 'docker-compose.yml', // не подтягивать доп. compose-файлы
  POSTGRES_PASSWORD: hex(24),
  JWT_SECRET,
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_PUBLISHABLE_KEY: '',
  SUPABASE_SECRET_KEY: '',
  JWT_KEYS: '',
  JWT_JWKS: '',
  ANON_KEY_ASYMMETRIC: '',
  SERVICE_ROLE_KEY_ASYMMETRIC: '',
  DASHBOARD_USERNAME: 'zpr_admin',
  DASHBOARD_PASSWORD: hex(12),
  SECRET_KEY_BASE: hex(32),
  VAULT_ENC_KEY: hex(16), // ровно 32 символа
  PG_META_CRYPTO_KEY: hex(16),
  S3_PROTOCOL_ACCESS_KEY_ID: hex(8),
  S3_PROTOCOL_ACCESS_KEY_SECRET: hex(24),
  POOLER_TENANT_ID: 'zpr',
  SUPABASE_PUBLIC_URL: `http://${WG_IP}:${KONG_PORT}`,
  API_EXTERNAL_URL: `http://${WG_IP}:${KONG_PORT}`,
  SITE_URL: `http://${WG_IP}:${UI_PORT}`,
  DISABLE_SIGNUP: 'true',
  ENABLE_EMAIL_AUTOCONFIRM: 'true',
  KONG_HTTP_PORT: KONG_PORT,
  KONG_HTTPS_PORT: '8443',
};

const lines = fs.readFileSync(examplePath, 'utf8').split(/\r?\n/);
const seen = new Set();
const out = lines.map((line) => {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (m && Object.prototype.hasOwnProperty.call(overrides, m[1])) {
    seen.add(m[1]);
    return `${m[1]}=${overrides[m[1]]}`;
  }
  return line;
});
// добавить ключи, которых не было в примере
for (const k of Object.keys(overrides)) {
  if (!seen.has(k)) out.push(`${k}=${overrides[k]}`);
}
fs.writeFileSync(outPath, out.join('\n'));
fs.chmodSync(outPath, 0o600);

// Печать только несекретного — для записи в UI/конфиги
console.log('WROTE ' + outPath);
console.log('ANON_KEY=' + ANON_KEY);
console.log('SERVICE_ROLE_KEY=' + SERVICE_ROLE_KEY);
console.log('SUPABASE_PUBLIC_URL=' + overrides.SUPABASE_PUBLIC_URL);
console.log('SITE_URL=' + overrides.SITE_URL);
console.log('POSTGRES_PASSWORD_LEN=' + overrides.POSTGRES_PASSWORD.length);
