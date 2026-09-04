"use client";

import { useEffect, useState } from "react";
import { PackageSearch } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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

const HEAD_CLASS = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

function flagVariant(flag: ReconciliationRow["flag"]): "default" | "secondary" | "destructive" | "outline" {
  if (flag === "integrity_alarm") return "destructive";
  if (flag === "not_refunded") return "outline";
  return "default";
}

function ReconciliationSkeletonRow() {
  return (
    <TableRow>
      <TableCell>
        <Skeleton className="h-4 w-20" />
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-4 w-16" />
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-4 w-16" />
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-4 w-16" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-28 rounded-full" />
      </TableCell>
    </TableRow>
  );
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
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <span className="font-mono text-sm tabular-nums text-muted-foreground">{rows.length} orders</span>
          {alarms > 0 && (
            <span className="text-sm font-medium text-destructive">
              {alarms} over-refunded
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD_CLASS}>Order</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Captured</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Refunded</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Remaining</TableHead>
                <TableHead className={HEAD_CLASS}>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 5 }).map((_, i) => <ReconciliationSkeletonRow key={i} />)}
              {!loading && rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <PackageSearch className="size-5" />
                      <span>No captured orders yet</span>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                rows.map((row) => (
                  // Over-refund is the single most important signal on this
                  // page — a left border stripe on the row itself gives it
                  // more weight than a badge in one cell alone would.
                  <TableRow
                    key={row.order_id}
                    className={row.flag === "integrity_alarm" ? "border-l-2 border-l-destructive" : undefined}
                  >
                    <TableCell className="font-mono font-semibold tabular-nums">{row.order_id}</TableCell>
                    <TableCell className="text-right font-mono font-semibold tabular-nums">
                      {formatMoney(row.captured_amount, row.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold tabular-nums">
                      {formatMoney(row.refunded, row.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold tabular-nums">
                      {formatMoney(row.remaining, row.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={flagVariant(row.flag)}
                        className={`font-mono ${
                          row.flag === "fully_refunded"
                            ? "bg-success text-success-foreground"
                            : row.flag === "partially_refunded"
                              ? "bg-warning text-warning-foreground"
                              : ""
                        }`}
                      >
                        <span className="size-1.5 rounded-full bg-current" />
                        {FLAG_LABEL[row.flag]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
