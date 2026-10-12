import type { Metadata } from "next";
import { LiveMarketplace } from "@/components/live/LiveMarketplace";

export const metadata: Metadata = {
  title: "PingMarket — Live SMS & Analytics",
};

export default function LivePage() {
  return <LiveMarketplace />;
}
