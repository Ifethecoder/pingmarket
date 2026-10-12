import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), thread: vi.fn(), connection: vi.fn() }));
vi.mock("next/server", () => ({
  connection: mocks.connection,
  NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
}));
vi.mock("@/lib/dial/runtime", () => ({ getDialRuntime: mocks.runtime }));
vi.mock("@/lib/sms/live", () => ({ listLiveThread: mocks.thread }));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("live Dial status", () => {
  it("exposes the service number and masked participant without secrets or sending", async () => {
    const sender = { send: vi.fn() };
    mocks.runtime.mockReturnValue({
      configured: true,
      webhookReady: true,
      sendsEnabled: false,
      serviceNumber: "+15550001000",
      participantNumber: "+15550002000",
      webhookSecret: "private-webhook-secret",
      errors: ["private diagnostic"],
      sender,
    });
    mocks.thread.mockResolvedValue([{ id: "msg", body: "HELP", direction: "inbound", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const response = await GET();
    const body = await response.json();
    expect(body).toEqual({
      configured: true,
      webhookReady: true,
      sendsEnabled: false,
      serviceNumber: "+15550001000",
      participantNumber: "…2000",
      messages: [{ id: "msg", body: "HELP", direction: "inbound", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    expect(mocks.thread).toHaveBeenCalledWith("+15550001000", "+15550002000");
    expect(sender.send).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("private");
    expect(mocks.connection).toHaveBeenCalledOnce();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns an empty thread and null numbers without Dial configuration", async () => {
    mocks.runtime.mockReturnValue({ configured: false, webhookReady: false, sendsEnabled: false, serviceNumber: null, participantNumber: null });
    mocks.thread.mockResolvedValue([]);
    expect(await (await GET()).json()).toEqual({
      configured: false,
      webhookReady: false,
      sendsEnabled: false,
      serviceNumber: null,
      participantNumber: null,
      messages: [],
    });
  });
});
