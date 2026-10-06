// Every window is a country. The note is worth one DODO everywhere; what
// changes at the border is how that value is written down.
// Rates are indicative (1 DODO = 1 USD) and deliberately round-ish.

export interface Country {
  code: string;
  name: string;
  /** how the note's country line reads */
  formal: string;
  currency: string;
  symbol: string;
  /** units of local currency per DODO */
  rate: number;
  /** the singular/plural of the currency, for the words on the note */
  unit: [string, string];
  /** passport stamp ink, sRGB 0..1 */
  stampInk: [number, number, number];
}

export const COUNTRIES: Country[] = [
  { code: 'US', name: 'United States', formal: 'United States of America', currency: 'USD', symbol: '$', rate: 1, unit: ['dollar', 'dollars'], stampInk: [0.13, 0.22, 0.55] },
  { code: 'IN', name: 'India', formal: 'Republic of India', currency: 'INR', symbol: '₹', rate: 83.2, unit: ['rupee', 'rupees'], stampInk: [0.55, 0.12, 0.38] },
  { code: 'JP', name: 'Japan', formal: 'Japan', currency: 'JPY', symbol: '¥', rate: 149, unit: ['yen', 'yen'], stampInk: [0.7, 0.1, 0.12] },
  { code: 'GB', name: 'United Kingdom', formal: 'United Kingdom', currency: 'GBP', symbol: '£', rate: 0.79, unit: ['pound', 'pounds'], stampInk: [0.2, 0.15, 0.45] },
  { code: 'FR', name: 'France', formal: 'République française', currency: 'EUR', symbol: '€', rate: 0.92, unit: ['euro', 'euros'], stampInk: [0.1, 0.32, 0.5] },
  { code: 'BR', name: 'Brazil', formal: 'República Federativa do Brasil', currency: 'BRL', symbol: 'R$', rate: 5.05, unit: ['real', 'reais'], stampInk: [0.1, 0.42, 0.22] },
  { code: 'NG', name: 'Nigeria', formal: 'Federal Republic of Nigeria', currency: 'NGN', symbol: '₦', rate: 1450, unit: ['naira', 'naira'], stampInk: [0.08, 0.4, 0.28] },
  { code: 'KR', name: 'South Korea', formal: 'Republic of Korea', currency: 'KRW', symbol: '₩', rate: 1340, unit: ['won', 'won'], stampInk: [0.15, 0.2, 0.5] },
  { code: 'MX', name: 'Mexico', formal: 'Estados Unidos Mexicanos', currency: 'MXN', symbol: '$', rate: 17.1, unit: ['peso', 'pesos'], stampInk: [0.45, 0.2, 0.1] },
  { code: 'TR', name: 'Türkiye', formal: 'Republic of Türkiye', currency: 'TRY', symbol: '₺', rate: 32.4, unit: ['lira', 'lira'], stampInk: [0.6, 0.1, 0.1] },
  { code: 'ID', name: 'Indonesia', formal: 'Republic of Indonesia', currency: 'IDR', symbol: 'Rp', rate: 15600, unit: ['rupiah', 'rupiah'], stampInk: [0.5, 0.15, 0.15] },
  { code: 'AU', name: 'Australia', formal: 'Commonwealth of Australia', currency: 'AUD', symbol: 'A$', rate: 1.52, unit: ['dollar', 'dollars'], stampInk: [0.15, 0.3, 0.45] },
];

export function countryByCode(code: string | null | undefined): number {
  const i = COUNTRIES.findIndex((c) => c.code === (code ?? '').toUpperCase());
  return i < 0 ? 0 : i;
}

/** "₹83.20", "¥149", "$1.00" */
export function formatMoney(c: Country, dodo: number): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: c.currency, currencyDisplay: 'narrowSymbol' }).format(dodo * c.rate);
  } catch {
    return `${c.symbol}${(dodo * c.rate).toFixed(2)}`;
  }
}
