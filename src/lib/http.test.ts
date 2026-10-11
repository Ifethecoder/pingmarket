import { describe, expect, it } from "vitest";
import { parseJsonBody } from "./http";

function post(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/x", { method: "POST", body, headers });
}

describe("parseJsonBody", () => {
  it("parses JSON", async () => {
    expect(await parseJsonBody(post('{"a":1}'))).toEqual({ ok: true, body: { a: 1 } });
  });

  it("rejects invalid JSON with 400", async () => {
    const r = await parseJsonBody(post("{"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it("rejects a declared content-length over 64 KiB with 413", async () => {
    const r = await parseJsonBody(post("{}", { "content-length": "65537" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(413);
      expect(await r.response.json()).toEqual({ error: "Request body too large" });
    }
  });
});
