import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type { SendButtonsArgs, SendTemplateArgs, SendTextArgs } from "./types.js";

/**
 * WATI outbound client. Thin wrapper with:
 *  - Bearer auth
 *  - Retry with exponential backoff on 5xx / network errors (up to 3 attempts)
 *  - No retry on 4xx (they're our bug, not a transient network issue)
 *
 * All feature code uses this via the `WatiClient` interface — do not import the
 * concrete client outside of tests and the server boot.
 */

export interface WatiClient {
  sendText(args: SendTextArgs): Promise<void>;
  sendButtons(args: SendButtonsArgs): Promise<void>;
  sendTemplate(args: SendTemplateArgs): Promise<void>;
}

async function withRetry(fn: () => Promise<Response>, label: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fn();
      if (res.ok) return res;
      // 4xx: don't retry — log and throw.
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "");
        throw new Error(`${label} ${res.status}: ${body.slice(0, 300)}`);
      }
      lastErr = new Error(`${label} ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    const backoffMs = 250 * 2 ** (attempt - 1);
    logger.warn({ label, attempt, backoffMs }, "WATI call failed, retrying");
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
}

export function createWatiClient(): WatiClient {
  const cfg = loadConfig();
  const headers = {
    Authorization: `Bearer ${cfg.WATI_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  return {
    async sendText({ waId, text }) {
      const url = `${cfg.WATI_API_BASE_URL}/api/v1/sendSessionMessage/${encodeURIComponent(waId)}`;
      await withRetry(
        () => fetch(url, { method: "POST", headers, body: JSON.stringify({ messageText: text }) }),
        "WATI.sendText",
      );
    },

    async sendButtons({ waId, body, buttons }) {
      if (buttons.length === 0 || buttons.length > 3) {
        throw new Error(`WATI allows 1–3 interactive buttons; got ${buttons.length}`);
      }
      const url = `${cfg.WATI_API_BASE_URL}/api/v2/sendInteractiveButtonsMessage?whatsappNumber=${encodeURIComponent(waId)}`;
      await withRetry(
        () =>
          fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              body,
              buttons: buttons.map((b) => ({ text: b.text })),
            }),
          }),
        "WATI.sendButtons",
      );
    },

    async sendTemplate({ waId, templateName, parameters }) {
      const url = `${cfg.WATI_API_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(waId)}`;
      await withRetry(
        () =>
          fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              template_name: templateName,
              broadcast_name: "cofounder_bot",
              parameters: parameters ?? [],
            }),
          }),
        "WATI.sendTemplate",
      );
    },
  };
}
