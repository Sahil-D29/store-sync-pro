import prisma from "../db.server";
import { createLogger } from "../utils/logger.server";

const log = createLogger("Currency");

const EXCHANGE_RATE_API = "https://api.exchangerate-api.com/v4/latest";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get the exchange rate between two currencies.
 * Checks database cache first, fetches from API if stale.
 */
export async function getExchangeRate(
  fromCurrency: string,
  toCurrency: string
): Promise<number> {
  if (fromCurrency === toCurrency) return 1;

  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  // Check cache
  const cached = await prisma.exchangeRate.findUnique({
    where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
  });

  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_DURATION_MS) {
    return cached.rate;
  }

  // Fetch fresh rate
  try {
    const rate = await fetchExchangeRate(from, to);

    await prisma.exchangeRate.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
      update: { rate, fetchedAt: new Date() },
      create: { fromCurrency: from, toCurrency: to, rate, fetchedAt: new Date() },
    });

    return rate;
  } catch (error) {
    log.error(`Failed to fetch exchange rate ${from}->${to}`, {
      error: (error as Error).message,
    });

    // Return cached rate even if stale, or fallback to 1
    return cached?.rate ?? 1;
  }
}

/**
 * Fetch exchange rate from external API.
 */
async function fetchExchangeRate(from: string, to: string): Promise<number> {
  const response = await fetch(`${EXCHANGE_RATE_API}/${from}`);
  if (!response.ok) {
    throw new Error(`Exchange rate API returned ${response.status}`);
  }

  const data = await response.json();
  const rate = data.rates?.[to];

  if (!rate) {
    throw new Error(`No rate found for ${from} -> ${to}`);
  }

  return rate;
}

/**
 * Refresh all cached exchange rates.
 * Call this periodically (e.g., daily cron job).
 */
export async function refreshAllExchangeRates(): Promise<{
  refreshed: number;
  errors: number;
}> {
  const rates = await prisma.exchangeRate.findMany();
  let refreshed = 0;
  let errors = 0;

  // Group by fromCurrency to minimize API calls
  const grouped = new Map<string, string[]>();
  for (const rate of rates) {
    if (!grouped.has(rate.fromCurrency)) {
      grouped.set(rate.fromCurrency, []);
    }
    grouped.get(rate.fromCurrency)!.push(rate.toCurrency);
  }

  for (const [from, targets] of grouped) {
    try {
      const response = await fetch(`${EXCHANGE_RATE_API}/${from}`);
      if (!response.ok) {
        errors += targets.length;
        continue;
      }

      const data = await response.json();

      for (const to of targets) {
        const newRate = data.rates?.[to];
        if (newRate) {
          await prisma.exchangeRate.update({
            where: {
              fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to },
            },
            data: { rate: newRate, fetchedAt: new Date() },
          });
          refreshed++;
        } else {
          errors++;
        }
      }
    } catch {
      errors += targets.length;
    }
  }

  log.info(`Exchange rates refreshed: ${refreshed} updated, ${errors} errors`);
  return { refreshed, errors };
}

/**
 * Get all cached exchange rates for display.
 */
export async function getAllExchangeRates() {
  return prisma.exchangeRate.findMany({
    orderBy: [{ fromCurrency: "asc" }, { toCurrency: "asc" }],
  });
}
