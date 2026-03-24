/**
 * Generic rate limiter utility for Shopify API calls.
 * Tracks available cost points per store.
 */

interface RateLimiterState {
  availablePoints: number;
  lastUpdated: number;
}

const storeLimiters = new Map<string, RateLimiterState>();

const MAX_POINTS = 1000;
const RESTORE_RATE = 50; // points per second

/**
 * Get or create a rate limiter state for a store.
 */
function getState(shopDomain: string): RateLimiterState {
  if (!storeLimiters.has(shopDomain)) {
    storeLimiters.set(shopDomain, {
      availablePoints: MAX_POINTS,
      lastUpdated: Date.now(),
    });
  }

  const state = storeLimiters.get(shopDomain)!;
  // Restore points based on time elapsed
  const elapsed = (Date.now() - state.lastUpdated) / 1000;
  state.availablePoints = Math.min(MAX_POINTS, state.availablePoints + elapsed * RESTORE_RATE);
  state.lastUpdated = Date.now();

  return state;
}

/**
 * Check if a request can proceed given estimated cost.
 * Returns delay in ms to wait, or 0 if can proceed immediately.
 */
export function getDelay(shopDomain: string, estimatedCost: number = 10): number {
  const state = getState(shopDomain);

  if (state.availablePoints >= estimatedCost) {
    return 0;
  }

  // Calculate wait time for enough points to restore
  const deficit = estimatedCost - state.availablePoints;
  return Math.ceil((deficit / RESTORE_RATE) * 1000);
}

/**
 * Consume points after a request completes.
 * Use actualCost from Shopify's throttle status when available.
 */
export function consumePoints(shopDomain: string, cost: number): void {
  const state = getState(shopDomain);
  state.availablePoints = Math.max(0, state.availablePoints - cost);
}

/**
 * Update available points from Shopify's throttle status response.
 */
export function updateFromThrottleStatus(
  shopDomain: string,
  currentlyAvailable: number
): void {
  const state = getState(shopDomain);
  state.availablePoints = currentlyAvailable;
  state.lastUpdated = Date.now();
}

/**
 * Wait until enough points are available.
 */
export async function waitForPoints(
  shopDomain: string,
  estimatedCost: number = 10
): Promise<void> {
  const delay = getDelay(shopDomain, estimatedCost);
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
