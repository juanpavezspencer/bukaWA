import { describe, expect, it } from "vitest";
import { parsePaymentMethod } from "../src/index.js";

describe("parsePaymentMethod", () => {
  it.each([
    ["cash", "cash"],
    ["bayar tunai", "cash"],
    ["kontan", "cash"],
    ["cash aja", "cash"],
    ["transfer BCA", "bank:BCA"],
    ["tf bca", "bank:BCA"],
    ["trf mandiri", "bank:Mandiri"],
    ["via BRI", "bank:BRI"],
    ["ke rek BNI", "bank:BNI"],
    ["bsi", "bank:BSI"],
    ["bank jago", "bank:Jago"],
    ["seabank", "bank:SeaBank"],
    ["transfer", "bank:other"],
    ["tf", "bank:other"],
    ["gopay", "ewallet:GoPay"],
    ["go-pay", "ewallet:GoPay"],
    ["OVO", "ewallet:OVO"],
    ["dana", "ewallet:DANA"],
    ["shopeepay", "ewallet:ShopeePay"],
    ["spay", "ewallet:ShopeePay"],
    ["linkaja", "ewallet:LinkAja"],
    ["qris", "qris"],
    ["scan QR", "qris"],
    ["jual nasi box 25 x 18rb transfer BCA", "bank:BCA"],
    ["belanja ayam 175rb cash", "cash"],
  ])("%s -> %s", (input, expected) => {
    expect(parsePaymentMethod(input)).toBe(expected);
  });

  it.each(["", "jual nasi box 25 x 18rb", "beli dana darurat"])("returns null for %j", (input) => {
    expect(parsePaymentMethod(input)).toBeNull();
  });
});
