import { useEffect, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Loader2, Save, User as UserIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const displayNameSchema = z.string().trim().min(1, "Required").max(60, "Max 60 characters");
const avatarUrlSchema = z
  .string()
  .trim()
  .max(500, "URL too long")
  .url("Must be a valid URL")
  .or(z.literal(""));

export function ProfileEditor() {
  const { user, profile } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.display_name ?? "");
    setAvatarUrl(profile?.avatar_url ?? "");
  }, [profile?.display_name, profile?.avatar_url]);

  const initials = (displayName || user?.email || "OP")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const dirty =
    displayName !== (profile?.display_name ?? "") ||
    avatarUrl !== (profile?.avatar_url ?? "");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const nameParse = displayNameSchema.safeParse(displayName);
    if (!nameParse.success) return toast.error(nameParse.error.issues[0].message);

    const urlParse = avatarUrlSchema.safeParse(avatarUrl);
    if (!urlParse.success) return toast.error(urlParse.error.issues[0].message);

    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          display_name: nameParse.data,
          avatar_url: urlParse.data || null,
        })
        .eq("user_id", user.id);

      if (error) {
        toast.error("Couldn't save profile.");
        return;
      }
      toast.success("Profile updated.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="h-14 w-14 rounded-full bg-secondary border border-border overflow-hidden flex items-center justify-center text-sm font-medium text-foreground shrink-0">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Operator avatar"
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <span>{initials || <UserIcon className="h-5 w-5 text-muted-foreground" />}</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">
            {displayName || "Unnamed operator"}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{user?.email}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="display-name" className="text-xs uppercase tracking-wider text-muted-foreground">
            Display name
          </Label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Sasha Nakamoto"
            maxLength={60}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="avatar-url" className="text-xs uppercase tracking-wider text-muted-foreground">
            Avatar URL
          </Label>
          <Input
            id="avatar-url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…/avatar.png"
            maxLength={500}
          />
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <Button type="submit" disabled={!dirty || saving} size="sm">
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Save className="h-4 w-4 mr-1.5" />
              Save profile
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
