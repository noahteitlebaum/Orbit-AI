// Proposal, not payment authorization. Provider expenses/legacy budget counters remain USD micros.
export const ECONOMICS = {
  subscriptionCadMicros: 30_000_000,
  monthlyAllowanceCadMicros: 20_000_000,
  trialAllowanceCadMicros: 2_500_000,
  trialDays: 7,
  paymentsEnabled: false,
  pricingVersion: "2026-10-13-standard",
};
export function usdToCad(micros: number, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("invalid_fx_rate");
  return Math.ceil(micros * rate);
}
export function cadToUsd(micros: number, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("invalid_fx_rate");
  return Math.floor(micros / rate);
}
