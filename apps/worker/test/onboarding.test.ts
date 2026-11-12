import { describe, expect, it } from "vitest";
import type { OutboundMessage } from "@bukuwa/wa";
import { onboardingStep, type OnboardingState } from "../src/onboarding.js";

const opts = { privacyPolicyUrl: "https://bukuwa.id/privasi", now: () => new Date("2026-11-12T03:00:00Z") };

function run(state: OnboardingState, ...inputs: Array<{ text?: string; replyId?: string }>) {
  let s = state;
  let last: ReturnType<typeof onboardingStep> | undefined;
  for (const input of inputs) {
    last = onboardingStep(s, input, opts);
    s = last.state;
  }
  return last!;
}

const start: OnboardingState = { step: "new" };
const text = (m: OutboundMessage) => (m.kind === "text" ? m.body : m.body);

describe("onboardingStep", () => {
  it("greets a new number and asks for consent with the privacy link", () => {
    const r = onboardingStep(start, { text: "halo" }, opts);
    expect(r.state.step).toBe("awaiting_consent");
    const msg = r.replies.at(-1)!;
    expect(msg.kind).toBe("buttons");
    expect(text(msg)).toContain("https://bukuwa.id/privasi");
    expect(r.complete).toBeUndefined();
  });

  it("walks the happy path to a confirmed business", () => {
    const r = run(
      start,
      { text: "halo" },
      { replyId: "consent_yes" },
      { text: "  Catering Bu Rina  " },
      { replyId: "type_fnb" },
      { text: "1,5jt" },
      { replyId: "confirm_ok" },
    );
    expect(r.state.step).toBe("done");
    expect(r.complete).toEqual({
      name: "Catering Bu Rina",
      type: "fnb",
      openingCash: 1_500_000n,
      consentAt: "2026-11-12T03:00:00.000Z",
    });
    expect(text(r.replies[0]!)).toMatch(/Catering Bu Rina/);
  });

  it("shows a summary with the formatted cash before creating anything", () => {
    const r = run(start, { text: "hi" }, { text: "setuju" }, { text: "Toko Dimas" }, { text: "2" }, { text: "500rb" });
    expect(r.state.step).toBe("awaiting_confirm");
    expect(r.complete).toBeUndefined();
    const card = r.replies[0]!;
    expect(card.kind).toBe("buttons");
    expect(text(card)).toContain("Rp 500.000");
    expect(text(card)).toContain("Fashion");
  });

  it("accepts typed answers instead of buttons", () => {
    const r = run(start, { text: "p" }, { text: "Iya setuju" }, { text: "Warung Pak Hendra" }, { text: "warung" }, { text: "0" }, { text: "ok" });
    expect(r.complete).toMatchObject({ type: "retail", openingCash: 0n });
  });

  it("stops if consent is declined and starts over on the next message", () => {
    const declined = run(start, { text: "halo" }, { replyId: "consent_no" });
    expect(declined.state.step).toBe("declined");
    expect(declined.state.consentAt).toBeUndefined();
    const again = onboardingStep(declined.state, { text: "halo lagi" }, opts);
    expect(again.state.step).toBe("awaiting_consent");
  });

  it("re-asks for consent on anything that is not a yes or no", () => {
    const r = run(start, { text: "halo" }, { text: "apa ini?" });
    expect(r.state.step).toBe("awaiting_consent");
    expect(r.replies.at(-1)!.kind).toBe("buttons");
  });

  it("re-asks when the name is empty or too long", () => {
    const base = run(start, { text: "halo" }, { replyId: "consent_yes" }).state;
    expect(onboardingStep(base, { text: "" }, opts).state.step).toBe("awaiting_name");
    expect(onboardingStep(base, {}, opts).state.step).toBe("awaiting_name");
    expect(onboardingStep(base, { text: "x".repeat(81) }, opts).state.step).toBe("awaiting_name");
  });

  it("re-asks when the type is not recognised", () => {
    const base = run(start, { text: "halo" }, { replyId: "consent_yes" }, { text: "Usaha Saya" }).state;
    const r = onboardingStep(base, { text: "entahlah" }, opts);
    expect(r.state.step).toBe("awaiting_type");
    expect(r.replies.at(-1)!.kind).toBe("list");
  });

  it("re-asks when the cash amount can't be parsed, with an example", () => {
    const base = run(start, { text: "halo" }, { replyId: "consent_yes" }, { text: "Usaha" }, { replyId: "type_other" }).state;
    const r = onboardingStep(base, { text: "lumayan banyak" }, opts);
    expect(r.state.step).toBe("awaiting_cash");
    expect(text(r.replies[0]!)).toMatch(/500rb/);
  });

  it("goes back to the name when the owner taps Ubah", () => {
    const base = run(start, { text: "halo" }, { replyId: "consent_yes" }, { text: "Usaha" }, { replyId: "type_other" }, { text: "1jt" }).state;
    const r = onboardingStep(base, { replyId: "confirm_edit" }, opts);
    expect(r.state.step).toBe("awaiting_name");
    expect(r.state.consentAt).toBe(base.consentAt); // consent is kept
  });

  it("keeps the opening cash JSON-safe in state", () => {
    const base = run(start, { text: "halo" }, { replyId: "consent_yes" }, { text: "Usaha" }, { replyId: "type_other" }, { text: "1jt" }).state;
    expect(JSON.parse(JSON.stringify(base))).toEqual(base);
  });
});
