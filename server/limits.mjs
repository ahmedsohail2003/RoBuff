// Abuse limits for the key server: a per-IP request rate, daily caps on Gemini calls,
// ElevenLabs characters and Nano Banana image units, and an origin check. All in memory: a restart resets them.

export const DEFAULT_LIMITS = Object.freeze({
  perMinute: 30,
  specPerDay: 300,
  ttsCharsPerDay: 20000,
  /** Nano Banana skin images, in units: a 'fast' image costs 1, a 'high' (Pro) image costs 4. */
  imagePerDay: 40,
});

/** Local calendar day, so the daily caps reset at the server's midnight. */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * @param {{ perMinute?: number, specPerDay?: number, ttsCharsPerDay?: number, imagePerDay?: number, now?: () => number }} [options]
 */
export function createLimits(options = {}) {
  const perMinute = options.perMinute ?? DEFAULT_LIMITS.perMinute;
  const specPerDay = options.specPerDay ?? DEFAULT_LIMITS.specPerDay;
  const ttsCharsPerDay = options.ttsCharsPerDay ?? DEFAULT_LIMITS.ttsCharsPerDay;
  const imagePerDay = options.imagePerDay ?? DEFAULT_LIMITS.imagePerDay;
  const now = options.now ?? Date.now;
  /** ip -> request times in the last minute, oldest first */
  const hits = new Map();
  let day = dayKey(now());
  let specCalls = 0;
  let ttsChars = 0;
  let imageCalls = 0;
  let imageUnits = 0;

  function rollDay() {
    const today = dayKey(now());
    if (today !== day) {
      day = today;
      specCalls = 0;
      ttsChars = 0;
      imageCalls = 0;
      imageUnits = 0;
    }
  }

  return {
    /** Counts one request from this IP. False once it has made perMinute in the last 60 s. */
    allowRequest(ip) {
      const t = now();
      const list = (hits.get(ip) ?? []).filter((at) => t - at < 60_000);
      if (list.length >= perMinute) {
        hits.set(ip, list);
        return false;
      }
      list.push(t);
      hits.set(ip, list);
      if (hits.size > 10_000) hits.clear();
      return true;
    },
    /** Takes one Gemini call from today's cap. False when the cap is used up. */
    takeSpec() {
      rollDay();
      if (specCalls >= specPerDay) return false;
      specCalls++;
      return true;
    },
    /** Takes this many ElevenLabs characters from today's cap. False if they do not fit. */
    takeTts(chars) {
      rollDay();
      if (ttsChars + chars > ttsCharsPerDay) return false;
      ttsChars += chars;
      return true;
    },
    /** Takes one image call costing this many units from today's cap. False if it does not fit. */
    takeImage(units = 1) {
      rollDay();
      if (!(units > 0) || imageUnits + units > imagePerDay) return false;
      imageUnits += units;
      imageCalls++;
      return true;
    },
    snapshot() {
      rollDay();
      return {
        per_minute: perMinute,
        spec_calls_today: specCalls,
        spec_calls_per_day: specPerDay,
        tts_chars_today: ttsChars,
        tts_chars_per_day: ttsCharsPerDay,
        image_calls_today: imageCalls,
        image_units_today: imageUnits,
        image_units_per_day: imagePerDay,
      };
    },
  };
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * True when a browser request comes from this app. A missing Origin (curl, the server's own
 * tests) is allowed: the origin check only stops other web pages from spending the quota
 * through a visitor's browser; the rate limit and daily caps cover everything else.
 * @param {string | undefined} origin
 * @param {string[]} extra origins from ALLOWED_ORIGINS, e.g. the deployed https site
 */
export function isAllowedOrigin(origin, extra = []) {
  if (origin === undefined || origin === '') return true;
  if (LOCAL_ORIGIN.test(origin)) return true;
  return extra.includes(origin);
}
