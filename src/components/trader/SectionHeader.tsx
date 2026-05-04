import { cn } from "@/lib/utils";
import { OwnerBadge, type OwnerName } from "@/components/trader/OwnerBadge";

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  owner?: OwnerName;
  roleSubtitle?: string;
  ownershipAction?: string;
  className?: string;
}

export function SectionHeader({ eyebrow, title, description, actions, owner, roleSubtitle, ownershipAction, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4 mb-6", className)}>
      <div className="space-y-1">
        {eyebrow && (
          <div className="text-[11px] uppercase tracking-[0.18em] text-primary/80 font-medium">{eyebrow}</div>
        )}
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{title}</h1>
        {(owner || roleSubtitle || ownershipAction) && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {owner && <OwnerBadge owner={owner} />}
            {roleSubtitle && <span className="text-xs text-muted-foreground">{roleSubtitle}</span>}
            {ownershipAction && <span className="text-xs text-muted-foreground">· {ownershipAction}</span>}
          </div>
        )}
        {description && <p className="text-sm text-muted-foreground max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
