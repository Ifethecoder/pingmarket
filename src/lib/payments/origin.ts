import { OrderError } from "../orders/service";

/** Production return URLs come from server configuration, never the request's Host header. */
export function appOrigin(req: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
      return url.origin;
    } catch {
      throw new OrderError("APP_URL_REQUIRED", "APP_URL is not a valid absolute HTTP URL (e.g. https://pingmarket.example.com)");
    }
  }
  if (process.env.NODE_ENV !== "production") return new URL(req.url).origin;
  throw new OrderError("APP_URL_REQUIRED", "Set APP_URL to the app's public origin to enable checkout in production");
}
