import { describe, expect, it } from "vitest";
import { cloudApiSender, inboundInput, toCloudApiPayload } from "../src/index.js";

describe("toCloudApiPayload", () => {
  it("builds a reply-button message", () => {
    const p = toCloudApiPayload("628123", {
      kind: "buttons",
      body: "Setuju?",
      buttons: [{ id: "yes", title: "Setuju" }],
    });
    expect(p).toMatchObject({
      to: "628123",
      type: "interactive",
      interactive: { type: "button", action: { buttons: [{ type: "reply", reply: { id: "yes", title: "Setuju" } }] } },
    });
  });

  it("enforces Cloud API limits", () => {
    const four = [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: `${i}` }));
    expect(() => toCloudApiPayload("1", { kind: "buttons", body: "x", buttons: four })).toThrow(/1-3 buttons/);
    expect(() =>
      toCloudApiPayload("1", { kind: "buttons", body: "x", buttons: [{ id: "a", title: "x".repeat(21) }] }),
    ).toThrow(/too long/);
    expect(() =>
      toCloudApiPayload("1", { kind: "list", body: "x", buttonText: "Pilih", rows: [{ id: "a", title: "x".repeat(25) }] }),
    ).toThrow(/too long/);
  });
});

describe("inboundInput", () => {
  it("reads text, button replies and list replies", () => {
    expect(inboundInput({ type: "text", text: { body: "halo" } })).toEqual({ text: "halo" });
    expect(inboundInput({ type: "interactive", interactive: { button_reply: { id: "ok", title: "OK" } } })).toEqual({
      replyId: "ok",
      text: "OK",
    });
    expect(inboundInput({ type: "interactive", interactive: { list_reply: { id: "t", title: "Fashion" } } })).toEqual({
      replyId: "t",
      text: "Fashion",
    });
    expect(inboundInput({ type: "image", image: {} })).toEqual({});
  });
});

describe("cloudApiSender", () => {
  it("posts to the Graph API with the token and returns the message id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sender = cloudApiSender({
      phoneNumberId: "PNID",
      accessToken: "tok",
      apiVersion: "v21.0",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
      },
    });
    expect(await sender.send("+628123", { kind: "text", body: "halo" })).toBe("wamid.OUT");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/PNID/messages");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ to: "628123", text: { body: "halo" } });
  });

  it("throws on HTTP errors", async () => {
    const sender = cloudApiSender({
      phoneNumberId: "P",
      accessToken: "t",
      apiVersion: "v21.0",
      fetch: async () => new Response("bad", { status: 400 }),
    });
    await expect(sender.send("+1", { kind: "text", body: "x" })).rejects.toThrow(/HTTP 400/);
  });
});
