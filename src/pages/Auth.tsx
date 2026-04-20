import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, Eye, EyeOff, Loader2 } from "lucide-react";

const emailSchema = z.string().trim().email("Enter a valid email").max(255);
const passwordSchema = z
  .string()
  .min(8, "At least 8 characters")
  .max(72, "Max 72 characters");
const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .max(60, "Max 60 characters");

export default function Auth() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/";

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // If already authed, kick to app
  useEffect(() => {
    if (!loading && user) navigate(from, { replace: true });
  }, [user, loading, from, navigate]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const e1 = emailSchema.safeParse(email);
      const p1 = passwordSchema.safeParse(password);
      if (!e1.success) return toast.error(e1.error.issues[0].message);
      if (!p1.success) return toast.error(p1.error.issues[0].message);

      const { error } = await supabase.auth.signInWithPassword({
        email: e1.data,
        password: p1.data,
      });
      if (error) {
        if (error.message.toLowerCase().includes("invalid")) {
          toast.error("Invalid credentials. Check email and password.");
        } else if (error.message.toLowerCase().includes("not confirmed")) {
          toast.error("Email not confirmed yet. Check your inbox.");
        } else {
          toast.error(error.message);
        }
        return;
      }
      toast.success("Welcome back, operator.");
      navigate(from, { replace: true });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const e1 = emailSchema.safeParse(email);
      const p1 = passwordSchema.safeParse(password);
      const d1 = displayNameSchema.safeParse(displayName);
      if (!d1.success) return toast.error(d1.error.issues[0].message);
      if (!e1.success) return toast.error(e1.error.issues[0].message);
      if (!p1.success) return toast.error(p1.error.issues[0].message);

      const { error } = await supabase.auth.signUp({
        email: e1.data,
        password: p1.data,
        options: {
          emailRedirectTo: `${window.location.origin}/`,
          data: { display_name: d1.data },
        },
      });
      if (error) {
        if (error.message.toLowerCase().includes("registered")) {
          toast.error("Email already registered. Try signing in.");
        } else {
          toast.error(error.message);
        }
        return;
      }
      toast.success("Account created. Check your inbox to verify your email.");
      setMode("signin");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 relative overflow-hidden">
      {/* Ambient amber glow */}
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
              Operator console
            </div>
          </div>
        </div>

        <div className="panel p-6">
          <Tabs value={mode} onValueChange={(v) => setMode(v as "signin" | "signup")}>
            <TabsList className="grid grid-cols-2 mb-5 bg-secondary">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Create account</TabsTrigger>
            </TabsList>

            <TabsContent value="signin" className="m-0">
              <form onSubmit={handleSignIn} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="signin-email" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Email
                  </Label>
                  <Input
                    id="signin-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="operator@desk.local"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signin-password" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Password
                  </Label>
                  <PasswordInput
                    id="signin-password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    show={showPassword}
                    onToggleShow={() => setShowPassword((s) => !s)}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enter the desk"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup" className="m-0">
              <form onSubmit={handleSignUp} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="signup-name" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Operator name
                  </Label>
                  <Input
                    id="signup-name"
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Sasha Nakamoto"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signup-email" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Email
                  </Label>
                  <Input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="operator@desk.local"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signup-password" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Password
                  </Label>
                  <PasswordInput
                    id="signup-password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    show={showPassword}
                    onToggleShow={() => setShowPassword((s) => !s)}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Provision operator"}
                </Button>
                <p className="text-[11px] text-muted-foreground text-center">
                  We'll email a verification link. Click it, then sign in.
                </p>
              </form>
            </TabsContent>
          </Tabs>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Single-operator workspace. Capital preservation first. No hype.
        </p>
      </div>
    </div>
  );
}
