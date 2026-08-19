import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(here, "..");
export const PUBLIC_ROOT = path.join(APP_ROOT, "public");
export const DATA_ROOT = path.resolve(process.env.LISTENING_DATA_DIR || path.join(APP_ROOT, ".data"));
export const MATERIALS_ROOT = path.join(DATA_ROOT, "materials");
export const TRASH_ROOT = path.join(DATA_ROOT, "trash");
export const JOBS_ROOT = path.join(DATA_ROOT, "jobs");
export const LEARNER_PROFILE_PATH = path.join(DATA_ROOT, "learner-profile.json");
export const AI_SETTINGS_PATH = path.join(DATA_ROOT, "settings.json");
export const MODEL_PATH = path.resolve(
  process.env.WHISPER_MODEL_PATH || path.join(APP_ROOT, ".models", "ggml-small.en.bin")
);
export const ANALYSIS_SCHEMA_PATH = path.join(APP_ROOT, "schemas", "analysis.schema.json");
export const SPOKEN_FORM_SCHEMA_PATH = path.join(APP_ROOT, "schemas", "spoken-form.schema.json");
export const QA_SCHEMA_PATH = path.join(APP_ROOT, "schemas", "qa.schema.json");
export const PHRASE_GUIDE_SCHEMA_PATH = path.join(APP_ROOT, "schemas", "phrase-guide.schema.json");
// This app intentionally has no remote authentication layer. Keep the service
// on loopback so meeting media and local APIs are never exposed to the LAN.
export const HOST = "127.0.0.1";
export const PORT = Number(process.env.PORT || 4173);
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024);
