// Numbers for spoken console lines: one number at a time, rounded like a person would say it.

function withCommas(integer: number): string {
  const digits = Math.abs(integer).toFixed(0);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return integer < 0 ? `-${out}` : out;
}

/** 1000000 -> "1,000,000", 54.95 -> "55", 4.25 -> "4.3", 0.0426 -> "0.043", 8.3e-5 -> "0.000083". */
export function say(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  // Past a thousand trillion, digits stop helping (and toFixed switches to exponent form).
  if (abs >= 1e15) {
    const exponent = Math.floor(Math.log10(abs));
    return `${Number((value / 10 ** exponent).toFixed(1))} x 10^${exponent}`;
  }
  if (abs >= 10) return withCommas(Math.round(value));
  if (abs >= 1) return String(Number(value.toFixed(1)));
  if (abs === 0) return '0';
  if (abs >= 1e-6) return String(Number(value.toPrecision(2)));
  return value.toExponential(1);
}

/** A length in millimetres, with metres or kilometres added when it helps. */
export function sayLength(mm: number): string {
  const unit = (n: number, word: string): string => `${say(n)} ${word}${say(n) === '1' ? '' : 's'}`;
  if (mm >= 1e6) return `${unit(mm, 'millimetre')} (about ${unit(mm / 1e6, 'kilometre')})`;
  if (mm >= 1e3) return `${unit(mm, 'millimetre')} (about ${unit(mm / 1e3, 'metre')})`;
  return unit(mm, 'millimetre');
}

/** A length as a measurement to the nearest tenth of a millimetre, so 1e-17 reads as 0. */
export function sayMm(mm: number): string {
  return say(Math.round(mm * 10) / 10);
}

/** A mass used as an adjective: "200 gram". */
export function sayMassLimit(kg: number): string {
  return kg >= 1 ? `${say(kg)} kilogram` : `${say(kg * 1000)} gram`;
}

/** Gravity to three significant figures: 9.82, 8.3e-5. */
export function sayGravityValue(g: number): string {
  if (g === 0) return '0';
  return Math.abs(g) < 1e-3 ? g.toExponential(1) : String(Number(g.toPrecision(3)));
}

/** A mass in kilograms, said in grams below 1 kg. */
export function sayMass(kg: number): string {
  if (kg >= 1) return `${say(kg)} kilograms`;
  return `${say(kg * 1000)} grams`;
}
