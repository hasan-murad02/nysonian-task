import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReviewQueue } from "@/components/review-queue";

export default function Home() {
  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Refund Triage Console</h1>
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Review Queue</TabsTrigger>
        </TabsList>
        <TabsContent value="queue">
          <ReviewQueue />
        </TabsContent>
      </Tabs>
    </div>
  );
}
