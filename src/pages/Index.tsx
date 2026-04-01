import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Bot, MessageSquare, Users, Zap, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const Index = () => {
  const { data: bots, isLoading: botsLoading, isError: botsError } = useQuery({
    queryKey: ["bots-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("bots" as any)
        .select("*", { count: "exact", head: true })
        .eq("is_active", true);

      if (error) throw error;
      return count || 0;
    },
    retry: 1,
  });

  const { data: pairsCount } = useQuery({
    queryKey: ["pairs-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("trigger_responses" as any)
        .select("*", { count: "exact", head: true });
      return count || 0;
    },
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card px-4 py-4">
        <div className="mx-auto max-w-4xl flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary">
            <Bot className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground">Bot Factory</h1>
            <p className="text-xs text-muted-foreground">စကားပြော Bot ဖန်တီးရန်</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 space-y-8">
        {/* Hero */}
        <section className="rounded-2xl bg-primary p-8 text-primary-foreground">
          <h2 className="text-2xl font-bold mb-2">🤖 Telegram Bot ဖန်တီးစက်</h2>
          <p className="text-primary-foreground/80 mb-6 text-sm leading-relaxed">
            AI မပါဘဲ လူသားတွေရဲ့ စကားပြောမှုတွေကနေ သင်ယူမှတ်သားပြီး ပြန်ပြောပေးတဲ့ Bot တွေကို ဖန်တီးပါ။
          </p>
          <a
            href="https://t.me/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-primary-foreground px-5 py-2.5 text-sm font-semibold text-primary transition-transform hover:scale-105"
          >
            Telegram မှာ စတင်ပါ
            <ArrowRight className="h-4 w-4" />
          </a>
        </section>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Active Bots</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                <span className="text-2xl font-bold text-foreground">{botsLoading ? "..." : botsError ? "0" : bots}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">သင်ယူထားသော Q&A</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5 text-accent" />
                <span className="text-2xl font-bold text-foreground">{pairsCount ?? 0}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* How it works */}
        <section className="space-y-4">
          <h3 className="text-lg font-bold text-foreground">အလုပ်လုပ်ပုံ</h3>
          <div className="space-y-3">
            {[
              { icon: <Zap className="h-5 w-5" />, title: "Bot ဖန်တီးပါ", desc: "Bot 1 ကို Telegram မှာ /start နှိပ်ပြီး API Key ပေးပို့ပါ" },
              { icon: <Users className="h-5 w-5" />, title: "Group ထဲ ထည့်ပါ", desc: "ဖန်တီးထားတဲ့ Bot ကို Group ထဲထည့်ပါ" },
              { icon: <MessageSquare className="h-5 w-5" />, title: "စကားပြော သင်ပေးပါ", desc: "User တွေ Reply နဲ့ ပြောတာကို Bot က မှတ်သားပါတယ်" },
              { icon: <Bot className="h-5 w-5" />, title: "Bot က ပြန်ပြောပါမယ်", desc: "တူညီတဲ့ မေးခွန်းကို သင်ယူထားတဲ့ အဖြေနဲ့ ပြန်ပြောပေးပါတယ်" },
            ].map((step, i) => (
              <div key={i} className="flex gap-4 rounded-xl bg-card p-4 border border-border">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  {step.icon}
                </div>
                <div>
                  <p className="font-semibold text-foreground text-sm">{step.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section className="rounded-2xl bg-card border border-border p-6 space-y-4">
          <h3 className="text-lg font-bold text-foreground">✨ အထူးအင်္ဂါရပ်များ</h3>
          <div className="grid gap-3 text-sm">
            <div className="flex items-start gap-3">
              <span className="text-accent font-bold">●</span>
              <p className="text-muted-foreground"><strong className="text-foreground">AI-Free</strong> — လူသားလို စကားပြော၊ AI မပါဘဲ</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-accent font-bold">●</span>
              <p className="text-muted-foreground"><strong className="text-foreground">Round-Robin</strong> — အဖြေတွေကို တစ်လှည့်စီ ထုတ်သုံးမယ်</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-accent font-bold">●</span>
              <p className="text-muted-foreground"><strong className="text-foreground">Cross-Group</strong> — Group တစ်ခုမှာ သင်ယူတာ အကုန်သုံးနိုင်</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-accent font-bold">●</span>
              <p className="text-muted-foreground"><strong className="text-foreground">Silent Learning</strong> — Command မလို၊ အလိုအလျောက် သင်ယူ</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default Index;
