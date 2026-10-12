/**
 * Live Keewano queries over its PostgreSQL wire endpoint (read-only `events` table). Server-side only.
 * See https://docs.keewano.com/sql-query-studio/guide.md — one table, no JOINs/CTEs, columns are event names.
 *
 * Needs KEEWANO_PAT (personal access token, `kwpat-…`), KEEWANO_USER_EMAIL and KEEWANO_PROJECT_ID (UUID).
 */
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

interface QueryConfig {
  user: string;
  token: string;
  projectId: string;
}

function config(): QueryConfig | null {
  const token = process.env.KEEWANO_PAT?.trim();
  const user = process.env.KEEWANO_USER_EMAIL?.trim();
  const projectId = process.env.KEEWANO_PROJECT_ID?.trim();
  return token && user && projectId ? { token, user, projectId } : null;
}

export function isKeewanoQueryConfigured(): boolean {
  return config() !== null && !process.env.VITEST;
}

function getClient(): Sql {
  const cfg = config();
  if (!cfg) throw new Error("Keewano query is not configured (KEEWANO_PAT, KEEWANO_USER_EMAIL, KEEWANO_PROJECT_ID)");
  client ??= postgres({
    host: "pgsql.keewano.com",
    port: 27543,
    database: cfg.projectId,
    username: cfg.user,
    password: cfg.token,
    ssl: "require",
    max: 2,
    // Keewano is an analytics engine speaking the protocol, not Postgres: no pg_catalog type lookup,
    // no prepared statements.
    fetch_types: false,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 60,
  });
  return client;
}

/** SQL string literal. Keewano statements are sent with the simple protocol, so values are inlined. */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quoted identifier for event-name columns such as `"Offer Band"`. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export type Row = Record<string, unknown>;

/** Runs one read-only statement; rejects after `timeoutMs` so callers on a request path stay fast. */
export async function keewanoQuery(text: string, timeoutMs = Number(process.env.KEEWANO_QUERY_TIMEOUT_MS) || 4000): Promise<Row[]> {
  const run = getClient().unsafe(text).simple();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      run.cancel?.();
      reject(new Error(`Keewano query timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const rows = await Promise.race([run, timeout]);
    return [...rows] as Row[];
  } finally {
    clearTimeout(timer);
  }
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
