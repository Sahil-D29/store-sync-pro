import { transformPrice } from "../app/services/price-transformer.server";

type Case = {
  name: string;
  rule: any;
  sourcePrice: string;
  compareAt?: string | null;
  exchangeRate?: number;
  expectPrice: string;
  expectCompareAt?: string | null;
};

// roundTo null => no rounding (so we can assert exact math)
const base = { applyToCompareAt: false, roundTo: null, targetCurrency: "USD" };

const cases: Case[] = [
  {
    name: "User scenario: 100 INR @ manual rate 100 -> 1 USD (no markup)",
    rule: { ...base, type: "CURRENCY_CONVERSION", value: 0, manualExchangeRate: 100 },
    sourcePrice: "100",
    expectPrice: "1.00",
  },
  {
    name: "User scenario: 100 INR @ rate 100, +10% markup -> 1.10 USD",
    rule: { ...base, type: "CURRENCY_CONVERSION", value: 10, manualExchangeRate: 100 },
    sourcePrice: "100",
    expectPrice: "1.10",
  },
  {
    name: "Currency conversion with -10% (decrease) -> 0.90 USD",
    rule: { ...base, type: "CURRENCY_CONVERSION", value: -10, manualExchangeRate: 100 },
    sourcePrice: "100",
    expectPrice: "0.90",
  },
  {
    name: "Currency conversion via live API rate (multiplier 0.012) -> 1.20",
    rule: { ...base, type: "CURRENCY_CONVERSION", value: 0, manualExchangeRate: null },
    sourcePrice: "100",
    exchangeRate: 0.012,
    expectPrice: "1.20",
  },
  {
    name: "Conversion applies to compareAt when enabled",
    rule: { ...base, type: "CURRENCY_CONVERSION", value: 0, manualExchangeRate: 100, applyToCompareAt: true },
    sourcePrice: "200",
    compareAt: "300",
    expectPrice: "2.00",
    expectCompareAt: "3.00",
  },
  {
    name: "Percentage markup +10% -> 110",
    rule: { ...base, type: "PERCENTAGE_MARKUP", value: 10 },
    sourcePrice: "100",
    expectPrice: "110.00",
  },
  {
    name: "Percentage discount -25% -> 75",
    rule: { ...base, type: "PERCENTAGE_DISCOUNT", value: 25 },
    sourcePrice: "100",
    expectPrice: "75.00",
  },
  {
    name: "Fixed markup +5 -> 105",
    rule: { ...base, type: "FIXED_MARKUP", value: 5 },
    sourcePrice: "100",
    expectPrice: "105.00",
  },
];

let failed = 0;
for (const c of cases) {
  const res = transformPrice(
    c.sourcePrice,
    c.compareAt ?? null,
    c.rule,
    "INR",
    c.exchangeRate
  );
  const okPrice = res.price === c.expectPrice;
  const okCompare =
    c.expectCompareAt === undefined || res.compareAtPrice === c.expectCompareAt;
  const ok = okPrice && okCompare;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}\n      price=${res.price} (expected ${c.expectPrice})` +
      (c.expectCompareAt !== undefined
        ? `  compareAt=${res.compareAtPrice} (expected ${c.expectCompareAt})`
        : "")
  );
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
