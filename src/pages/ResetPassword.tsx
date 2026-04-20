import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Activity, ArrowLeft, Eye, EyeOff, Loader2 } from "lucide-react";

const passwordSchema = z
  .string()
  .min(8, "At least 8 characters")
  .max(72, "Max 72 characters");

export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [recoveryValid, setRecoveryValid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Supabase parses the recovery hash and creates a temporary session.
    // We listen for the PASSWORD_RECOVERY event AND check for an existing session
    // (in case the event fired before this component mounted).
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        setRecoveryValid(true);
        setReady(true);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setRecoveryValid(true);
      // If no session and no recovery hash, show the "invalid link" state.
      const hash = window.location.hash;
      const hasRecoveryHash = hash.includes("type=recovery") || hash.includes("access_token");
      if (!session && !hasRecoveryHash) setRecoveryValid(false);
      setReady(true);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p1 = passwordSchema.safeParse(password);
    if (!p1.success) return toast.error(p1.error.issues[0].message);
    if (password !== confirm) return toast.error("Passwords don't match.");

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: p1.data });
      if (error) {
        toast.error(error.message || "Couldn't update password.");
        return;
      }
      toast.success("Password updated. Signing you in…");
      // Sign out the recovery session so the user lands on a clean state.
      await supabase.auth.signOut();
      navigate("/auth", { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -right-32 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-32 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="flex items-center gap-2 mb-6">
          <div className="h-8 w-8 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Activity className="h-4 w-4 text-primary" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-wide text-foreground">TRADER OS</div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Reset password
            </div>
          </div>
        </div>

        <div className="panel p-6">
          {!ready ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : !recoveryValid ? (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium text-foreground">Recovery link expired</div>
                <p className="text-xs text-muted-foreground mt-1">
                  This password reset link is invalid or has already been used. Request a new one from the sign-in screen.
                </p>
              </div>
              <Button variant="outline" className="w-full" onClick={() => navigate("/auth")}>
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <div className="text-sm font-medium text-foreground">Set a new password</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Pick something strong. You'll be sent back to sign in afterwards.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-password" className="text-xs uppercase tracking-wider text-muted-foreground">
                  New password
                </Label>
                <PasswordField
                  id="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  show={showPassword}
                  onToggleShow={() => setShowPassword((s) => !s)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm-password" className="text-xs uppercase tracking-wider text-muted-foreground">
                  Confirm new password
                </Label>
                <PasswordField
                  id="confirm-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Type it again"
                  autoComplete="new-password"
                  show={showPassword}
                  onToggleShow={() => setShowPassword((s) => !s)}
                />
              </div>

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update password"}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Single-operator workspace. Capital preservation first. No hype.
        </p>
      </div>
    </div>
  );
}

type PasswordFieldProps = {
  id: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoComplete?: string;
  show: boolean;
  onToggleShow: () => void;
};

function PasswordField({ id, value, onChange, placeholder, autoComplete, show, onToggleShow }: PasswordFieldProps) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required
        className="pr-10"
      />
      <button
        type="button"
        onClick={onToggleShow}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        tabIndex={-1}
        className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
