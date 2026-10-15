declare namespace Cloudflare {
  interface Env {
    ADMIN_SETUP_TOKEN?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
