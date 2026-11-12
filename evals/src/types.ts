import type { RawExtraction } from "@bukuwa/ai";

export interface ExpectedEntry {
  kind: string;
  /** Integer rupiah as a decimal string. */
  amount_idr: string;
  payment_method: string | null;
  date: string;
}

export interface TextCase {
  id: string;
  text: string;
  /** "Today" in the business timezone when the message was sent. */
  today: string;
  expected: { intent: string; entries?: ExpectedEntry[] };
  /**
   * The spans an ideal extractor would copy out (confidence omitted). Lets an
   * offline test check the code-side normalizer on every case without a model.
   */
  oracle?: Omit<RawExtraction, "entries"> & { entries: Array<Omit<RawExtraction["entries"][number], "confidence">> };
  tags: string[];
}
