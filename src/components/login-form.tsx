"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "sign-in" | "sign-up";

/**
 * Thin UI over the auth client: no business logic, no direct provider calls —
 * it delegates to src/lib/auth/client and routes the user afterwards.
 */
export function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              email,
              password,
              name: name.trim() === "" ? email : name.trim(),
            });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="font-heading text-base leading-snug font-medium">
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </h1>
        </CardTitle>
        <CardDescription>
          {mode === "sign-in"
            ? "Use the seeded demo account or your own credentials."
            : "Email and password are stored in PostgreSQL via Better Auth."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
          {mode === "sign-up" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada Lovelace"
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="demo@orqestra.dev"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={pending}>
            {pending ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setError(null);
            }}
          >
            {mode === "sign-in" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
