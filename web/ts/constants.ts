export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;

export const SSE_BACKOFF_DELAYS_MS = [250, 250, 500, 1_000, 1_000, 2_000, 5_000] as const;

export const PRF_SALT_INPUT = "tansu-prf-salt-v1";
export const PRF_CHALLENGE_LENGTH = 32;
export const PRF_USER_ID = new Uint8Array([1]);
export const PRF_PUBLIC_KEY_PARAMS = [
  { alg: -7, type: "public-key" },
  { alg: -257, type: "public-key" },
] as const;

export const MIN_SUPPORTED_FIREFOX_VERSION = 148;
