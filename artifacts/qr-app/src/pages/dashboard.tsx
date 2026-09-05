import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Activity,
  Server,
  CheckCircle,
  XCircle,
  RefreshCw,
  ArrowRight,
  Link,
} from "lucide-react";

interface ApiStatus {
  name: string;
  path: string;
  status: "loading" | "ok" | "error";
  response?: any;
  error?: string;
}

const endpoints = [
  { name: "Health", path: "/api/healthz" },
  { name: "Auth Register", path: "/api/v1/auth/register" },
  { name: "Auth Login", path: "/api/v1/auth/login" },
  { name: "Orders", path: "/api/v1/orders" },
  { name: "Menu", path: "/api/v1/menu" },
  { name: "Payments", path: "/api/v1/payments" },
  { name: "Reservations", path: "/api/v1/reservations" },
  { name: "Ratings", path: "/api/v1/ratings" },
  { name: "Notifications", path: "/api/v1/notifications" },
  { name: "Panel Dashboard", path: "/api/v1/panel/branches/1/dashboard" },
  { name: "Admin Dashboard", path: "/api/v1/admin/dashboard" },
  { name: "Admin Restaurants", path: "/api/v1/admin/restaurants" },
];

export default function Dashboard() {
  const [statuses, setStatuses] = useState<ApiStatus[]>(
    endpoints.map((e) => ({ ...e, status: "loading" }))
  );
  const [checking, setChecking] = useState(false);

  async function checkEndpoint(status: ApiStatus, index: number) {
    try {
      const response = await fetch(status.path, {
        method: status.path.includes("register") || status.path.includes("login")
          ? "POST"
          : "GET",
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json().catch(() => null);
      setStatuses((prev) =>
        prev.map((s, i) =>
          i === index
            ? {
                ...s,
                status: response.ok ? "ok" : "error",
                response: data,
                error: response.ok ? undefined : `${response.status} ${response.statusText}`,
              }
            : s
        )
      );
    } catch (err: any) {
      setStatuses((prev) =>
        prev.map((s, i) =>
          i === index
            ? { ...s, status: "error", error: err.message || "Network error" }
            : s
        )
      );
    }
  }

  async function checkAll() {
    setChecking(true);
    setStatuses(endpoints.map((e) => ({ ...e, status: "loading" })));
    await Promise.all(
      endpoints.map((e, i) => checkEndpoint({ ...e, status: "loading" }, i))
    );
    setChecking(false);
  }

  useEffect(() => {
    checkAll();
  }, []);

  const okCount = statuses.filter((s) => s.status === "ok").length;
  const errorCount = statuses.filter((s) => s.status === "error").length;
  const loadingCount = statuses.filter((s) => s.status === "loading").length;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">API Dashboard</h1>
          <p className="text-muted-foreground">Real-time status of all API endpoints</p>
        </div>
        <Button onClick={checkAll} disabled={checking} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          {checking ? "Checking..." : "Refresh All"}
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-3 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Online
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span className="text-2xl font-bold">{okCount}</span>
              <span className="text-sm text-muted-foreground">/ {endpoints.length}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Errors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <span className="text-2xl font-bold">{errorCount}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Loading
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-yellow-500" />
              <span className="text-2xl font-bold">{loadingCount}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Endpoints Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Endpoint Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {statuses.map((status) => (
              <div
                key={status.name}
                className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {status.status === "ok" && (
                    <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
                  )}
                  {status.status === "error" && (
                    <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                  )}
                  {status.status === "loading" && (
                    <RefreshCw className="h-5 w-5 text-yellow-500 shrink-0 animate-spin" />
                  )}
                  <div>
                    <p className="font-medium">{status.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{status.path}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {status.status === "ok" && (
                    <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full">
                      200 OK
                    </span>
                  )}
                  {status.status === "error" && (
                    <span className="text-xs text-red-600 bg-red-50 px-2 py-1 rounded-full">
                      {status.error || "Error"}
                    </span>
                  )}
                  {status.status === "loading" && (
                    <span className="text-xs text-yellow-600 bg-yellow-50 px-2 py-1 rounded-full">
                      Checking...
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1"
                    onClick={() =>
                      window.open(
                        `${window.location.origin}${status.path}`,
                        "_blank"
                      )
                    }
                  >
                    <Link className="h-3 w-3" />
                    Test
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
