import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReviewQueue } from "@/components/review-queue";
import { Reconciliation } from "@/components/reconciliation";

export default function Home() {
  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Refund Triage Console</h1>
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Review Queue</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
        </TabsList>
        <TabsContent value="queue">
          <ReviewQueue />
        </TabsContent>
        <TabsContent value="reconciliation">
          <Reconciliation />
        </TabsContent>
      </Tabs>
    </div>
  );
}
