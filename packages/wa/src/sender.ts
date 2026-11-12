import { toCloudApiPayload, type OutboundMessage } from "./messages.js";

export interface WaSender {
  /** Returns the WhatsApp message id of the sent message. */
  send(toE164: string, msg: OutboundMessage): Promise<string | undefined>;
}

export interface CloudApiConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version, e.g. "v21.0"; from config. */
  apiVersion: string;
  fetch?: typeof fetch;
}

export function cloudApiSender(cfg: CloudApiConfig): WaSender {
  const doFetch = cfg.fetch ?? fetch;
  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
  return {
    async send(toE164, msg) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(toCloudApiPayload(toE164.replace(/^\+/, ""), msg)),
      });
      if (!res.ok) {
        throw new Error(`WhatsApp send failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      }
      const json = (await res.json()) as { messages?: Array<{ id: string }> };
      return json.messages?.[0]?.id;
    },
  };
}
