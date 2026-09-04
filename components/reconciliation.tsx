"use client";

import { useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoneyFromString as formatMoney } from "@/lib/money";

interface ReconciliationRow {
  order_id: string;
  currency: string;
  captured_amount: string;
  refunded: string;
  remaining: string;
  flag: "integrity_alarm" | "fully_refunded" | "partially_refunded" | "not_refunded";
}

const FLAG_LABEL: Record<ReconciliationRow["flag"], string> = {
  integrity_alarm: "over-refunded",
  fully_refunded: "fully refunded",
  partially_refunded: "partially refunded",
  not_refunded: "not refunded",
};

// shadcn's Badge has no built-in "success" variant, but a reconciliation
// view is exactly the kind of dense table meant to be scanned at a glance —
// matching DIAGRAMS.md's own 🟢/🟡/🔴 intent is worth a few custom classes.
function flagClassName(flag: ReconciliationRow["flag"]): string {
  if (flag === "fully_refunded") return "bg-green-600 text-white";
  if (flag === "partially_refunded") return "bg-amber-500 text-white";
  return "";
}

function flagVariant(flag: ReconciliationRow["flag"]): "default" | "secondary" | "destructive" | "outline" {
  if (flag === "integrity_alarm") return "destructive";
  if (flag === "not_refunded") return "outline";
  return "default";
}

export function Reconciliation() {
  const [rows, setRows] = useState<ReconciliationRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/reconciliation")
      .then((res) => res.json())
      .then((data) => setRows(data.orders ?? []))
      .finally(() => setLoading(false));
  }, []);

  const alarms = rows.filter((r) => r.flag === "integrity_alarm").length;

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        {rows.length} orders{alarms > 0 && <span className="ml-2 text-destructive">— {alarms} over-refunded</span>}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Captured</TableHead>
            <TableHead>Refunded</TableHead>
            <TableHead>Remaining</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell colSpan={5}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ))}
          {!loading &&
            rows.map((row) => (
              <TableRow key={row.order_id}>
                <TableCell>{row.order_id}</TableCell>
                <TableCell>{formatMoney(row.captured_amount, row.currency)}</TableCell>
                <TableCell>{formatMoney(row.refunded, row.currency)}</TableCell>
                <TableCell>{formatMoney(row.remaining, row.currency)}</TableCell>
                <TableCell>
                  <Badge variant={flagVariant(row.flag)} className={flagClassName(row.flag)}>
                    {FLAG_LABEL[row.flag]}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
