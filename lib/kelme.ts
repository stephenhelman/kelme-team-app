/**
 * Server-side Kelme B2B client. The token and the plain-http China host must
 * never reach the browser — only call these from route handlers / the seed
 * script, never from a "use client" component or anything imported by one.
 *
 * The session token lives in the DB (KelmeToken, singleton id 1), shared
 * between the app and the worker, not in a static env var — Kelme rolls the
 * token forward on live calls (a fresh value in the `Token` response
 * header), and the old env-var approach couldn't persist that, so it slowly
 * degraded. See lib/kelme-token.ts for the store.
 */
import {
  getStoredKelmeToken,
  markKelmeTokenDead,
  saveRefreshedKelmeToken,
} from "./kelme-token";

const B2B_URL =
  process.env.KELME_B2B_URL ??
  "http://gkemb2b.kelmechina.com:5020/svr/portal/servlets/binserv/B2B";
const ORIGIN = process.env.KELME_ORIGIN ?? "http://gkemb2b.kelmechina.com:5020";

export async function isKelmeTokenConfigured(): Promise<boolean> {
  const stored = await getStoredKelmeToken();
  return stored !== null && stored.status === "alive";
}

interface KelmeTransactionResult {
  // Kelme is inconsistent about this being a string ("000005") or a number
  // (1009) across endpoints/error paths — normalize with String(code)
  // before comparing or persisting, never compare the raw value.
  code: string | number;
  message?: string;
  result?: unknown;
}

// Kelme codes observed to mean "session is dead, re-auth required." Add to
// this set the moment a new one turns up — code:000005 is the only one this
// app used to watch for, and a dead token (code:1009, "会话超时或尚未登录，
// 请重新登录" / session timeout / not logged in) sailed through undetected
// until the sanity guard caught the fallout. The message patterns are a
// backstop for codes we haven't catalogued yet.
const DEAD_SESSION_CODES = new Set(["000005", "1009"]);
const DEAD_SESSION_MESSAGE_PATTERNS = [/会话超时/, /尚未登录/, /重新登录/, /session\s*timeout/i, /not\s*logged\s*in/i];

function deadSessionCode(tx: KelmeTransactionResult | undefined): string | undefined {
  if (!tx) return undefined;
  const code = tx.code != null ? String(tx.code) : undefined;
  if (code && DEAD_SESSION_CODES.has(code)) return code;
  if (tx.message && DEAD_SESSION_MESSAGE_PATTERNS.some((p) => p.test(tx.message!))) return code || "unknown";
  return undefined;
}

async function callB2B(command: string, params: Record<string, unknown>): Promise<KelmeTransactionResult> {
  const stored = await getStoredKelmeToken();
  if (!stored) {
    throw new Error("No Kelme token stored — seed one via scripts/seed-kelme-token.mjs to call Kelme");
  }
  if (stored.status !== "alive") {
    // Every call after the first cycle that discovered the death lands
    // here (the token stays "dead" in the DB until re-auth) — route it
    // through markKelmeTokenDead too, not just a bare throw, so a failed
    // notification send gets retried on a later cycle instead of only
    // ever being attempted once, at the original detection.
    // markKelmeTokenDead no-ops the DB writes when already dead and skips
    // the send entirely once deadNotifiedAt is set from a prior success.
    await markKelmeTokenDead(`token status is "${stored.status}"`);
    throw new Error(`Kelme session expired — token status is "${stored.status}", re-auth required`);
  }

  const transactions = [{ id: 1, command: "com.agilecontrol.b2bweb.B2BCmd", params: { parentnode: -1, cmd: command, ...params } }];
  const body = new URLSearchParams();
  body.set("transactions", JSON.stringify(transactions));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response: Response;
  try {
    response = await fetch(B2B_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Token: stored.accessToken,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/portal/`,
      },
      body: body.toString(),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(controller.signal.aborted ? "Kelme request timed out after 30s" : `Kelme network error: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Kelme returned HTTP ${response.status}`);
  }

  // Kelme rolls the session token forward on live calls — a fresh value
  // shows up in the `Token` response header. Persist it so the next call
  // (from either the app or the worker) picks up the current token instead
  // of the one that's about to expire.
  const freshToken = response.headers.get("token");
  if (freshToken && freshToken !== stored.accessToken) {
    await saveRefreshedKelmeToken(freshToken);
  }

  const data = await response.json();
  const tx: KelmeTransactionResult = Array.isArray(data) ? data[0] : data;

  const deathCode = deadSessionCode(tx);
  if (deathCode) {
    await markKelmeTokenDead(deathCode);
    throw new Error(`Kelme session expired (code ${deathCode}) — token marked dead, re-auth required`);
  }

  return tx;
}

export interface RawFavoriteProduct {
  no: string;
  note: string;
  price: number;
  discount_price: number;
  colors: string;
  mainpic: string;
  stylename: string;
  fabelement?: string;
  id: number;
  [dimKey: `m_dim${number}_id`]: string | undefined;
}

export interface FavoritesPage {
  total: number;
  products: RawFavoriteProduct[];
}

// Endpoint A: the vendor's favorited catalog — the store itself (~152 items).
export async function fetchFavoritesPage(start: number, pagesize: number): Promise<FavoritesPage> {
  const tx = await callB2B("b2b.pdt.search", { start, pagesize, isfav: true });
  const result = tx.result as { total?: number; pdt_s?: RawFavoriteProduct[] } | undefined;
  return {
    total: result?.total ?? 0,
    products: Array.isArray(result?.pdt_s) ? result.pdt_s : [],
  };
}

export interface RawPriceListEntry {
  name?: string;
  value?: string | number;
}

export interface RawProductDetail {
  no: string;
  note: string;
  price: number;
  priceList?: RawPriceListEntry[];
  colors: string; // NAME-ONLY hint — never a code source, never used for image mapping
  allpic: string[];
  mainpic: string;
  [dimKey: `m_dim${number}_id`]: string | undefined;
}

// Endpoint B: single product detail, keyed on pdtid.
export async function fetchProductDetail(pdtid: number): Promise<RawProductDetail> {
  const tx = await callB2B("b2b.pdt.get", { id: pdtid });
  return (tx.result as RawProductDetail) ?? ({} as RawProductDetail);
}

// Endpoint D: structured product attributes (Gender, Sub-category,
// Collection, Seasons, Composition/Material, Weight/Piece, Function, Top or
// Lower, Description, ...) keyed on pdtid. Distinct from b2b.pdt.get
// (product summary) — a separate call, separate shape: the attribute list
// lives at result.data (result.groups just labels the "Product Parameter"
// section, unused here). Confirmed against a live b2b.pdt.detail response.
export interface RawProductAttribute {
  title: string;
  value: string;
}

export async function fetchProductAttributes(pdtid: number): Promise<RawProductAttribute[]> {
  const tx = await callB2B("b2b.pdt.detail", { pdtid });
  const result = tx.result as { data?: RawProductAttribute[] } | undefined;
  return Array.isArray(result?.data) ? result.data : [];
}

// Confirmed against a live b2b.pdt.sheet response: a spreadsheet grid, cells
// keyed "row:col". Each color gets 3 rows starting at a qtyRow index R:
// R = "Order Quantity" (editable, ignored here), R+1 = "Headquarters
// Inventory" (the stock we want), R+2 = "Pending Inventory" (ignored). The
// size header lives in row 0 at each sizeCol index, newline-separated
// (KELME size first). colorContrast maps the row-0 label ("{styleCode}
// {ColorName},{code}") to the color code.
export interface SkuSheetCell {
  t: "s" | "i" | "f";
  e?: boolean;
  v?: string;
  f?: string; // formula text — the per-unit FOB cost is embedded here as amt(<price>, ...)
  k?: string;
}

export interface RawSkuSheet {
  def?: {
    cells: Record<string, SkuSheetCell>;
    rows: number;
    cols: number;
    config: {
      sizeCol: number[];
      qtyRow: number[];
      colorContrast: Record<string, string>;
    };
  };
  [key: string]: unknown;
}

// Endpoint C: per-product color x size stock grid, keyed on pdtid.
export async function fetchSkuSheet(pdtid: number): Promise<RawSkuSheet> {
  const tx = await callB2B("b2b.pdt.sheet", { pdtid });
  return (tx.result as RawSkuSheet) ?? {};
}

// Per-color product photos live at a fixed pattern on the same image host as
// mainpic — confirmed via a HEAD-check sweep across sample products (not
// every color has one; reachability is checked per-product at seed time).
const IMAGE_BASE = "http://gkemb2b.kelmechina.com:5020/kelmeb2bhw/product/normal";

export function buildColorImageUrl(styleCode: string, colorCode: string): string {
  return `${IMAGE_BASE}/${styleCode}_${colorCode}_01.jpg`;
}

// Server-side-only reachability check, run at seed/refresh time — never on a
// live click. Any failure (404, timeout, network error) is treated as "this
// color has no dedicated photo", not an exception.
export async function checkImageExists(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
