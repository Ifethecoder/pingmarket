import type { Metadata } from "next";
import { SmsSimulator } from "@/components/sim/SmsSimulator";

export const metadata: Metadata = {
  title: "PingMarket — Simulated Phones",
};

export default function SimPage() {
  return <SmsSimulator />;
}
