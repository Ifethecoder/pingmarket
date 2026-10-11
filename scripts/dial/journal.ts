import { DatabaseSync } from "node:sqlite";
import type { ReceivedSms, SmsInbox, SmsSender } from "../../src/lib/sms/ports.ts";

/** Local connectivity-test journal only. Not PingMarket's application database. */
export class ConnectivityJournal implements SmsInbox {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connectivity_messages (
        event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, status TEXT NOT NULL,
        attempted_at INTEGER, provider_message_id TEXT
      );
    `);
  }
  async receive(message: ReceivedSms): Promise<"stored" | "duplicate"> {
    const result = this.db.prepare(`INSERT INTO connectivity_messages(event_id,message_id,payload,status)
      VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).run(message.eventId, message.messageId, JSON.stringify(message),
      message.body.trim().toUpperCase() === "PING" ? "pending" : "ignored");
    return result.changes ? "stored" : "duplicate";
  }
  async replyOnce(sender: SmsSender, now = Date.now()): Promise<boolean> {
    this.db.prepare(`UPDATE connectivity_messages SET status='unknown'
      WHERE status='sending' AND attempted_at < ?`).run(now - 300_000);
    // Claim is persisted BEFORE sending. A crash leaves 'sending', which ages
    // into 'unknown' and is never automatically sent again.
    const row = this.db.prepare(`UPDATE connectivity_messages SET status='sending', attempted_at=?
      WHERE event_id=(SELECT event_id FROM connectivity_messages WHERE status='pending' ORDER BY rowid LIMIT 1)
      RETURNING event_id,payload`).get(now) as { event_id: string; payload: string } | undefined;
    if (!row) return false;
    const message = JSON.parse(row.payload) as ReceivedSms;
    try {
      const result = await sender.send(message.from, "PingMarket connection test: received your PING.");
      this.db.prepare(`UPDATE connectivity_messages SET status=?,provider_message_id=? WHERE event_id=?`).run(
        result.status, result.status === "accepted" ? result.providerMessageId : null, row.event_id,
      );
    } catch {
      this.db.prepare("UPDATE connectivity_messages SET status='unknown' WHERE event_id=?").run(row.event_id);
    }
    return true;
  }
  summary(): { status: string; count: number }[] {
    return this.db.prepare("SELECT status, count(*) AS count FROM connectivity_messages GROUP BY status ORDER BY status").all() as { status: string; count: number }[];
  }
  close() { this.db.close(); }
}
