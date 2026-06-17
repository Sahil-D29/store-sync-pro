import type { PriceRule } from "@prisma/client";
import prisma from "../db.server";

interface PriceTransformResult {
  price: string;
  compareAtPrice: string | null;
}

/**
 * Transform a price according to a PriceRule
 */
export function transformPrice(
  sourcePrice: string,
  sourceCompareAtPrice: string | null,
  priceRule: PriceRule,
  sourceCurrency?: string,
  exchangeRate?: number
): PriceTransformResult {
  let price = parseFloat(sourcePrice);
  let compareAtPrice = sourceCompareAtPrice
    ? parseFloat(sourceCompareAtPrice)
    : null;

  switch (priceRule.type) {
    case "PERCENTAGE_MARKUP":
      price = price * (1 + priceRule.value / 100);
      if (priceRule.applyToCompareAt && compareAtPrice) {
        compareAtPrice = compareAtPrice * (1 + priceRule.value / 100);
      }
      break;

    case "PERCENTAGE_DISCOUNT":
      price = price * (1 - priceRule.value / 100);
      if (priceRule.applyToCompareAt && compareAtPrice) {
        compareAtPrice = compareAtPrice * (1 - priceRule.value / 100);
      }
      break;

    case "FIXED_MARKUP":
      price = price + priceRule.value;
      if (priceRule.applyToCompareAt && compareAtPrice) {
        compareAtPrice = compareAtPrice + priceRule.value;
      }
      break;

    case "FIXED_DISCOUNT":
      price = Math.max(0, price - priceRule.value);
      if (priceRule.applyToCompareAt && compareAtPrice) {
        compareAtPrice = Math.max(0, compareAtPrice - priceRule.value);
      }
      break;

    case "CURRENCY_CONVERSION": {
      // `value` is an additional markup % applied on top of the conversion
      // (e.g. value = 10 => x1.1, value = -10 => x0.9).
      const markupFactor = 1 + priceRule.value / 100;
      const manualRate = (priceRule as any).manualExchangeRate as
        | number
        | null
        | undefined;

      if (manualRate && manualRate > 0) {
        // Manual rate is entered as "how many SOURCE-currency units equal 1
        // unit of the target currency" (e.g. 100 means 100 INR = 1 USD), so we
        // DIVIDE: 100 INR / 100 = 1 USD, then apply the markup.
        price = (price / manualRate) * markupFactor;
        if (priceRule.applyToCompareAt && compareAtPrice) {
          compareAtPrice = (compareAtPrice / manualRate) * markupFactor;
        }
      } else if (exchangeRate) {
        // The live API rate is a direct multiplier: 1 source unit = `rate`
        // target units (e.g. 1 INR = 0.012 USD), so we MULTIPLY.
        price = price * exchangeRate * markupFactor;
        if (priceRule.applyToCompareAt && compareAtPrice) {
          compareAtPrice = compareAtPrice * exchangeRate * markupFactor;
        }
      }
      break;
    }
  }

  // Apply rounding
  if (priceRule.roundTo !== null && priceRule.roundTo !== undefined) {
    price = applyRounding(price, priceRule.roundTo);
    if (compareAtPrice !== null) {
      compareAtPrice = applyRounding(compareAtPrice, priceRule.roundTo);
    }
  }

  // Ensure non-negative
  price = Math.max(0, price);
  if (compareAtPrice !== null) {
    compareAtPrice = Math.max(0, compareAtPrice);
  }

  return {
    price: price.toFixed(2),
    compareAtPrice: compareAtPrice !== null ? compareAtPrice.toFixed(2) : null,
  };
}

/**
 * Round price to nearest ending (e.g., .99, .95, .00)
 */
function applyRounding(price: number, roundTo: number): number {
  if (roundTo === 0) {
    return Math.round(price);
  }

  // roundTo represents the decimal ending (e.g., 0.99, 0.95)
  const wholePart = Math.floor(price);
  const decimalPart = roundTo;

  // If current price decimal is less than roundTo, use previous whole number
  if (price - wholePart < decimalPart) {
    return wholePart > 0 ? wholePart - 1 + decimalPart : decimalPart;
  }

  return wholePart + decimalPart;
}

/**
 * Get exchange rate between two currencies
 */
export async function getExchangeRate(
  fromCurrency: string,
  toCurrency: string
): Promise<number> {
  if (fromCurrency === toCurrency) return 1;

  const cached = await prisma.exchangeRate.findUnique({
    where: {
      fromCurrency_toCurrency: { fromCurrency, toCurrency },
    },
  });

  // Use cached rate if less than 24 hours old
  if (cached) {
    const hoursSinceFetch =
      (Date.now() - cached.fetchedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceFetch < 24) {
      return cached.rate;
    }
  }

  // Fetch new rate
  const rate = await fetchExchangeRate(fromCurrency, toCurrency);

  // Cache it
  await prisma.exchangeRate.upsert({
    where: {
      fromCurrency_toCurrency: { fromCurrency, toCurrency },
    },
    update: { rate, fetchedAt: new Date() },
    create: { fromCurrency, toCurrency, rate },
  });

  return rate;
}

/**
 * Fetch exchange rate from a free API
 */
async function fetchExchangeRate(
  fromCurrency: string,
  toCurrency: string
): Promise<number> {
  try {
    const response = await fetch(
      `https://api.exchangerate-api.com/v4/latest/${fromCurrency}`
    );

    if (!response.ok) {
      throw new Error(`Exchange rate API error: ${response.status}`);
    }

    const data = await response.json();
    const rate = data.rates?.[toCurrency];

    if (!rate) {
      throw new Error(
        `Exchange rate not found for ${fromCurrency} -> ${toCurrency}`
      );
    }

    return rate;
  } catch (error) {
    // Fallback: return 1 if we can't fetch
    console.error("Failed to fetch exchange rate:", error);
    return 1;
  }
}
