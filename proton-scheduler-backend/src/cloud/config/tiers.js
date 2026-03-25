// ---------------------------------------------------------------------------
// Tier definitions — Open-source self-hosted edition
// All features are unlocked. No billing or subscription enforcement.
// ---------------------------------------------------------------------------

const UNLIMITED_LIMITS = {
  eventTypes:       Infinity,
  bookingPages:     Infinity,
  bookingsPerMonth: Infinity,
  teamMembers:      Infinity,
  teamScheduling:   true,
  cancelBooking:    true,
  customBranding:   false,
  removeBranding:   true,
  webhooks:         false,
  apiAccess:        true,
  calendarSync:     false,
  customDomain:     false,
  prioritySupport:  false,
  analytics:        false,
};

const TIERS = {
  free: {
    name: 'Self-Hosted',
    stripePriceId: null,
    stripeYearlyPriceId: null,
    limits: UNLIMITED_LIMITS,
  },
};

export function getTier(tierName) {
  return TIERS.free;
}

export function getTierByPriceId(priceId) {
  return 'free';
}

export function checkLimit(tierName, limitKey, currentUsage = 0) {
  const limit = UNLIMITED_LIMITS[limitKey];
  if (typeof limit === 'boolean') {
    return { allowed: limit, limit, current: null };
  }
  return { allowed: true, limit, current: currentUsage };
}

/** Infinity → "unlimited" so limits survive JSON.stringify */
export function serializeLimits(limits) {
  return Object.fromEntries(
    Object.entries(limits).map(([k, v]) => [k, v === Infinity ? 'unlimited' : v])
  );
}

export { TIERS };
export default TIERS;
