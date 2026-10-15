import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Публичный сайт не позволяет первому посетителю назначить себя администратором.
// Ключ известен только владельцу и хранится как секрет окружения Sites.
export function canConfigureAdmin(request, expectedToken) {
  const suppliedToken = request.headers.get('x-setup-token') || '';
  if (typeof expectedToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(expectedToken) || !/^[A-Za-z0-9_-]{43}$/.test(suppliedToken)) return false;
  return timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(expectedToken));
}
