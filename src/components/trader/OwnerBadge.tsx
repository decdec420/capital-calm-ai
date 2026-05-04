import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Brain, Briefcase, Crown, Shield, Sparkles, User, Users } from "lucide-react";

export type OwnerName = "Bobby" | "Wags" | "Taylor" | "Brain Trust" | "Wendy" | "Katrina" | "Hall";

const ownerMeta: Record<OwnerName, { Icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  Bobby: { Icon: Crown, tone: "bg-primary/10 text-primary border-primary/30" },
  Wags: { Icon: Briefcase, tone: "bg-status-safe/10 text-status-safe border-status-safe/30" },
  Taylor: { Icon: Shield, tone: "bg-status-caution/10 text-status-caution border-status-caution/30" },
  "Brain Trust": { Icon: Brain, tone: "bg-secondary text-secondary-foreground border-border" },
  Wendy: { Icon: Users, tone: "bg-status-safe/10 text-status-safe border-status-safe/30" },
  Katrina: { Icon: Sparkles, tone: "bg-primary/10 text-primary border-primary/30" },
  Hall: { Icon: User, tone: "bg-secondary text-secondary-foreground border-border" },
};

export function OwnerBadge({ owner, className }: { owner: OwnerName; className?: string }) {
  const { Icon, tone } = ownerMeta[owner];
  return (
    <Badge variant="outline" className={cn("gap-1 px-1.5 py-0 text-[10px] font-medium", tone, className)}>
      <Icon className="h-2.5 w-2.5" />
      Owned by {owner}
    </Badge>
  );
}

