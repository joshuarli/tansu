export const AUTOCOMPLETE_MAX_RESULTS = 10;
export const AUTOCOMPLETE_OFFSET_PX = 4;

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_SCORE_PRECISION = 3;

export const SETTINGS_WEIGHT_TITLE_DEFAULT = 10;
export const SETTINGS_WEIGHT_HEADINGS_DEFAULT = 5;
export const SETTINGS_WEIGHT_TAGS_DEFAULT = 25;
export const SETTINGS_WEIGHT_CONTENT_DEFAULT = 1;
export const SETTINGS_FUZZY_DISTANCE_DEFAULT = 1;
export const SETTINGS_RECENCY_BOOST_DEFAULT = 2;
export const SETTINGS_RESULT_LIMIT_DEFAULT = 20;
export const SETTINGS_SHOW_SCORE_BREAKDOWN_DEFAULT = true;

export const SETTINGS_WEIGHT_MIN = 0;
export const SETTINGS_WEIGHT_MAX = 20;
export const SETTINGS_WEIGHT_STEP = 0.5;
export const SETTINGS_RESULT_LIMIT_MIN = 5;
export const SETTINGS_RESULT_LIMIT_MAX = 100;
export const SETTINGS_RESULT_LIMIT_STEP = 5;
export const SETTINGS_FUZZY_DISTANCE_OPTIONS = [0, 1, 2] as const;
export const SETTINGS_RECENCY_BOOST_OPTIONS = [0, 1, 2, 3] as const;

export const AUTOSAVE_DELAY_MS = 1500;
export const AUTOSAVE_RETRY_DELAY_MS = 500;
export const UNDO_STACK_MAX_ENTRIES = 200;

export const IMAGE_WEBP_QUALITY = 0.85;
export const IMAGE_RESIZE_MIN_WIDTH_PX = 50;
export const IMAGE_RESIZE_WHEEL_SCALE = 1.5;

export const FORMAT_TOOLBAR_GAP_PX = 8;
export const FORMAT_TOOLBAR_EDGE_PADDING_PX = 8;
export const FORMAT_TOOLBAR_ICON_SIZE_PX = 13;
export const FORMAT_TOOLBAR_STROKE_WIDTH = 1.75;
export const FORMAT_TOOLBAR_HEADING_LEVELS = [1, 2, 3, 4] as const;

export const TAG_AUTOCOMPLETE_MAX_RESULTS = 10;
export const TAG_AUTOCOMPLETE_OFFSET_PX = 4;
export const TAG_AUTOCOMPLETE_MIN_WIDTH_PX = 160;

export const MAX_CLOSED_TABS = 20;
export const MAX_INDENT_SPACES = 4;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;

export const NOTIFICATION_AUTO_DISMISS_MS = 5_000;

export const SSE_BACKOFF_DELAYS_MS = [250, 250, 500, 1_000, 1_000, 2_000, 5_000] as const;

export const PRF_SALT_INPUT = "tansu-prf-salt-v1";
export const PRF_CHALLENGE_LENGTH = 32;
export const PRF_USER_ID = new Uint8Array([1]);
export const PRF_PUBLIC_KEY_PARAMS = [
  { alg: -7, type: "public-key" },
  { alg: -257, type: "public-key" },
] as const;

export const MIN_SUPPORTED_FIREFOX_VERSION = 148;
export const SEARCH_CLI_DEFAULT_PORT = "3000";
