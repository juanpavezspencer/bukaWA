/**
 * Mask NIK (16 digits) and NPWP (15 or 16 digits, often formatted
 * 01.234.567.8-901.000) before any text is sent to an LLM. Digits may be
 * grouped with single spaces, dots or dashes.
 */
const ID_LIKE = /(?<![\d.])\d(?:[ .-]?\d){14,15}(?![\d])/g;

export function maskSensitiveIds(text: string): string {
  return text.replace(ID_LIKE, (match) => {
    const digits = match.replace(/\D/g, "").length;
    return digits === 15 || digits === 16 ? "[ID]" : match;
  });
}
