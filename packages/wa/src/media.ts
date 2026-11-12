/** Media sent by the owner, as referenced in the webhook payload. */
export interface InboundMedia {
  /** image: photos and screenshots; pdf: invoices sent as documents; audio: voice notes. */
  kind: "image" | "pdf" | "audio";
  /** Cloud API media id; download with a MediaFetcher. */
  id: string;
  mimeType: string;
  caption?: string;
}

/** Types the vision model accepts. WhatsApp sends photos as JPEG or PNG. */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export function inboundMedia(raw: Record<string, unknown>): InboundMedia | null {
  const m = raw as {
    type?: string;
    image?: { id?: string; mime_type?: string; caption?: string };
    audio?: { id?: string; mime_type?: string };
    document?: { id?: string; mime_type?: string; caption?: string };
  };
  const mime = (s: string | undefined) => (s ?? "").split(";")[0]!.trim().toLowerCase();
  if (m.type === "image" && m.image?.id) {
    return { kind: "image", id: m.image.id, mimeType: mime(m.image.mime_type) || "image/jpeg", caption: m.image.caption };
  }
  if (m.type === "audio" && m.audio?.id) {
    return { kind: "audio", id: m.audio.id, mimeType: mime(m.audio.mime_type) || "audio/ogg" };
  }
  if (m.type === "document" && m.document?.id) {
    const t = mime(m.document.mime_type);
    const caption = m.document.caption;
    if (t === "application/pdf") return { kind: "pdf", id: m.document.id, mimeType: t, caption };
    if ((IMAGE_MIME_TYPES as readonly string[]).includes(t)) return { kind: "image", id: m.document.id, mimeType: t, caption };
  }
  return null;
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
}

export interface MediaFetcher {
  fetch(mediaId: string): Promise<DownloadedMedia>;
}

export class MediaTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`media is ${bytes} bytes, over the limit`);
    this.name = "MediaTooLargeError";
  }
}

export interface CloudApiMediaConfig {
  accessToken: string;
  apiVersion: string;
  /** Reject anything larger (bytes). */
  maxBytes: number;
  fetch?: typeof fetch;
}

/**
 * Cloud API media download is two steps: GET /{media-id} returns a short-lived
 * URL, then GET that URL with the same bearer token returns the bytes.
 */
export function cloudApiMediaFetcher(cfg: CloudApiMediaConfig): MediaFetcher {
  const doFetch = cfg.fetch ?? fetch;
  const auth = { authorization: `Bearer ${cfg.accessToken}` };
  return {
    async fetch(mediaId) {
      const metaRes = await doFetch(`https://graph.facebook.com/${cfg.apiVersion}/${encodeURIComponent(mediaId)}`, { headers: auth });
      if (!metaRes.ok) throw new Error(`WhatsApp media lookup failed: HTTP ${metaRes.status}`);
      const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!meta.url) throw new Error("WhatsApp media lookup returned no url");
      if (meta.file_size && meta.file_size > cfg.maxBytes) throw new MediaTooLargeError(meta.file_size);

      const res = await doFetch(meta.url, { headers: auth });
      if (!res.ok) throw new Error(`WhatsApp media download failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > cfg.maxBytes) throw new MediaTooLargeError(bytes.byteLength);
      return { bytes, mimeType: (meta.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim() };
    },
  };
}
