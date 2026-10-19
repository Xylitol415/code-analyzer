/** This schema deliberately has no credential, session ID or transcript fields. */
export interface SavedConfiguration {
  id: string;
  project: string;
  baseUrl: string;
  modelMode: "backend" | "custom";
  model: string;
  llmBaseUrl: string;
  llmModel: string;
  usedAt: number;
}

export type ConfigurationInput = Pick<SavedConfiguration, "project" | "baseUrl" | "modelMode" | "model" | "llmBaseUrl" | "llmModel">;
export const CONFIG_HISTORY_KEY = "code-analyzer:configuration-history:v1";
export const CONFIG_HISTORY_LIMIT = 10;
type HistoryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): HistoryStorage | null {
  try { return window.localStorage ?? null; } catch { return null; }
}

function endpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const text = value.trim().replace(/\/+$/, "");
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return text;
  } catch { return null; }
}

function configuration(input: unknown): ConfigurationInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.project !== "string" || !raw.project.trim() || raw.project.length > 4096) return null;
  const project = raw.project.trim();
  // A repository URL can also carry credentials. Do not persist those URLs.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(project)) {
    try { const url = new URL(project); if (url.username || url.password || url.search || url.hash) return null; }
    catch { return null; }
  }
  const baseUrl = endpoint(raw.baseUrl);
  if (!baseUrl || (raw.modelMode !== "backend" && raw.modelMode !== "custom")) return null;
  if (raw.modelMode === "custom") {
    const llmBaseUrl = endpoint(raw.llmBaseUrl);
    if (!llmBaseUrl || typeof raw.llmModel !== "string" || !raw.llmModel.trim() || raw.llmModel.length > 512) return null;
    return { project, baseUrl, modelMode: "custom", model: "", llmBaseUrl, llmModel: raw.llmModel.trim() };
  }
  if (typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 512) return null;
  return { project, baseUrl, modelMode: "backend", model: raw.model.trim(), llmBaseUrl: "", llmModel: "" };
}

const identity = (entry: ConfigurationInput) => JSON.stringify([entry.project, entry.baseUrl, entry.modelMode, entry.model, entry.llmBaseUrl, entry.llmModel]);

export function rememberConfiguration(entries: SavedConfiguration[], input: ConfigurationInput, now = Date.now()): SavedConfiguration[] {
  const safe = configuration(input);
  if (!safe) return entries;
  const key = identity(safe);
  const previous = entries.find(entry => identity(entry) === key);
  const recent = { ...safe, id: previous?.id ?? crypto.randomUUID(), usedAt: now };
  return [recent, ...entries.filter(entry => identity(entry) !== key)].slice(0, CONFIG_HISTORY_LIMIT);
}

export function loadConfigurationHistory(storage: HistoryStorage | null = browserStorage()): SavedConfiguration[] {
  try {
    const text = storage?.getItem(CONFIG_HISTORY_KEY);
    if (!text || text.length > 256 * 1024) return [];
    const data = JSON.parse(text);
    if (data?.version !== 1 || !Array.isArray(data.entries)) return [];
    const seen = new Set<string>();
    const ids = new Set<string>();
    return data.entries.flatMap((raw: Record<string, unknown>) => {
      const safe = configuration(raw);
      if (!safe || typeof raw.id !== "string" || !raw.id || raw.id.length > 128 || typeof raw.usedAt !== "number" || !Number.isFinite(raw.usedAt)) return [];
      return [{ ...safe, id: raw.id, usedAt: raw.usedAt }];
    }).sort((a: SavedConfiguration, b: SavedConfiguration) => b.usedAt - a.usedAt).filter((entry: SavedConfiguration) => {
      const key = identity(entry);
      if (seen.has(key) || ids.has(entry.id)) return false;
      seen.add(key); ids.add(entry.id); return true;
    }).slice(0, CONFIG_HISTORY_LIMIT);
  } catch { return []; }
}

export function saveConfigurationHistory(entries: SavedConfiguration[], storage: HistoryStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    // Re-whitelist on write; never spread caller-owned objects into localStorage.
    const safe = entries.flatMap(entry => {
      const value = configuration(entry);
      return value ? [{ ...value, id: entry.id, usedAt: entry.usedAt }] : [];
    }).slice(0, CONFIG_HISTORY_LIMIT);
    storage.setItem(CONFIG_HISTORY_KEY, JSON.stringify({ version: 1, entries: safe }));
    return true;
  } catch { return false; }
}

export function clearConfigurationHistory(storage: HistoryStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try { storage.removeItem(CONFIG_HISTORY_KEY); return true; } catch { return false; }
}
