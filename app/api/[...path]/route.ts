import { env } from 'cloudflare:workers';
import { handleApi } from '../../../src/server/service.mjs';
import { canConfigureAdmin } from '../../../src/server/setup-access.mjs';

export const dynamic = 'force-dynamic';
async function handler(request: Request) {
  // Публичная страница входа; права сотрудников проверяются в нашем API.
  return handleApi(request, {
    db: env.DB,
    allowSetup: canConfigureAdmin(request, env.ADMIN_SETUP_TOKEN),
    secureCookies: new URL(request.url).protocol === 'https:'
  });
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
