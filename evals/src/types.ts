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

export interface ExpectedDocEntry {
  kind: string;
  amount_idr: string;
  date: string;
  /** Sender for money in; store/supplier/recipient for money out. Matched loosely. */
  counterparty: string | null;
  payment_method: string | null;
}

/** One photo/PDF case. `file` is relative to evals/datasets/images/ (.svg is rendered to PNG at run time). */
export interface ImageCase {
  id: string;
  file: string;
  today: string;
  business_name: string;
  caption?: string;
  expected: { is_document: boolean; entries?: ExpectedDocEntry[] };
  /** The exact text drawn on a synthetic image and the spans an ideal reader would copy. */
  oracle?: { visible_text: string; entries: Array<Omit<RawExtraction["entries"][number], "confidence">> };
  tags: string[];
}

/** One question or correction about the fixture books (books-fixture.ts). */
export interface QuestionCase {
  id: string;
  text: string;
  today: string;
  expected: {
    intent: "question" | "correction";
    /** answer: must quote every must_include amount; unsupported: must quote no amounts; correction: must propose this. */
    kind: "answer" | "unsupported" | "correction";
    must_include?: string[];
    correction?: { entry_key: string; action: "change" | "cancel"; amount_idr?: string; payment_code?: string };
  };
  /** The tool call(s) an ideal agent makes; an offline test checks they return the expected amounts. */
  oracle?: Array<{ tool: string; input: unknown }>;
  tags: string[];
}
