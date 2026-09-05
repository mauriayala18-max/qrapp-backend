import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  BookOpen,
  Code,
  Key,
  Users,
  ShoppingCart,
  Utensils,
  CreditCard,
  Calendar,
  Star,
  Bell,
  Shield,
  Crown,
  Zap,
  ArrowRight,
  Copy,
  CheckCircle,
} from "lucide-react";
import { useState } from "react";

interface Endpoint {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  description: string;
  auth?: string;
}

interface ModuleDocs {
  icon: React.ElementType;
  title: string;
  description: string;
  endpoints: Endpoint[];
}

const modules: ModuleDocs[] = [
  {
    icon: Key,
    title: "Auth",
    description: "User registration, login, and session management",
    endpoints: [
      { method: "POST", path: "/api/v1/auth/register", description: "Register new user" },
      { method: "POST", path: "/api/v1/auth/login", description: "User login" },
      { method: "POST", path: "/api/v1/auth/logout", description: "Logout user" },
      { method: "GET", path: "/api/v1/auth/me", description: "Get current user" },
    ],
  },
  {
    icon: ShoppingCart,
    title: "Orders",
    description: "Order management and tracking",
    endpoints: [
      { method: "GET", path: "/api/v1/orders", description: "List orders" },
      { method: "POST", path: "/api/v1/orders", description: "Create order" },
      { method: "GET", path: "/api/v1/orders/:id", description: "Get order details" },
      { method: "PATCH", path: "/api/v1/orders/:id", description: "Update order" },
    ],
  },
  {
    icon: Utensils,
    title: "Menu & Products",
    description: "Menu management and product catalog",
    endpoints: [
      { method: "GET", path: "/api/v1/menu", description: "List menu items" },
      { method: "GET", path: "/api/v1/products", description: "List products" },
      { method: "POST", path: "/api/v1/products", description: "Create product" },
      { method: "GET", path: "/api/v1/categories", description: "List categories" },
    ],
  },
  {
    icon: CreditCard,
    title: "Payments",
    description: "Payment processing and transactions",
    endpoints: [
      { method: "GET", path: "/api/v1/payments", description: "List payments" },
      { method: "POST", path: "/api/v1/payments", description: "Create payment" },
      { method: "GET", path: "/api/v1/payments/:id", description: "Get payment details" },
    ],
  },
  {
    icon: Calendar,
    title: "Reservations",
    description: "Table booking and reservations",
    endpoints: [
      { method: "GET", path: "/api/v1/reservations", description: "List reservations" },
      { method: "POST", path: "/api/v1/reservations", description: "Create reservation" },
      { method: "GET", path: "/api/v1/reservations/:id", description: "Get reservation" },
    ],
  },
  {
    icon: Star,
    title: "Ratings & Reviews",
    description: "Customer ratings and reviews",
    endpoints: [
      { method: "GET", path: "/api/v1/ratings", description: "List ratings" },
      { method: "POST", path: "/api/v1/ratings", description: "Create rating" },
      { method: "GET", path: "/api/v1/ratings/:id", description: "Get rating" },
    ],
  },
  {
    icon: Bell,
    title: "Notifications",
    description: "Push notifications and alerts",
    endpoints: [
      { method: "GET", path: "/api/v1/notifications", description: "List notifications" },
      { method: "POST", path: "/api/v1/notifications", description: "Send notification" },
    ],
  },
  {
    icon: Shield,
    title: "Restaurant Panel",
    description: "Restaurant admin dashboard APIs",
    endpoints: [
      { method: "GET", path: "/api/v1/panel/branches/:id/dashboard", description: "Branch dashboard" },
      { method: "GET", path: "/api/v1/panel/branches/:id/orders", description: "Branch orders" },
      { method: "GET", path: "/api/v1/panel/branches/:id/menu", description: "Branch menu" },
    ],
  },
  {
    icon: Crown,
    title: "Super Admin",
    description: "Platform-wide admin management",
    endpoints: [
      { method: "GET", path: "/api/v1/admin/dashboard", description: "Admin dashboard" },
      { method: "GET", path: "/api/v1/admin/restaurants", description: "List restaurants" },
      { method: "GET", path: "/api/v1/admin/subscriptions", description: "List subscriptions" },
      { method: "GET", path: "/api/v1/admin/tickets", description: "Support tickets" },
      { method: "GET", path: "/api/v1/admin/alerts", description: "Platform alerts" },
      { method: "GET", path: "/api/v1/admin/config", description: "Global config" },
    ],
  },
];

const methodColors: Record<string, string> = {
  GET: "bg-blue-50 text-blue-700 border-blue-200",
  POST: "bg-green-50 text-green-700 border-green-200",
  PATCH: "bg-yellow-50 text-yellow-700 border-yellow-200",
  DELETE: "bg-red-50 text-red-700 border-red-200",
};

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
  const [copied, setCopied] = useState(false);

  const copyPath = () => {
    navigator.clipboard.writeText(endpoint.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0">
      <Badge variant="outline" className={`${methodColors[endpoint.method]} shrink-0 w-16 justify-center`}>
        {endpoint.method}
      </Badge>
      <code className="text-sm font-mono text-muted-foreground flex-1">{endpoint.path}</code>
      <span className="text-sm text-muted-foreground hidden sm:block">{endpoint.description}</span>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={copyPath}>
        {copied ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export default function APIDocs() {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <BookOpen className="h-7 w-7" />
          API Documentation
        </h1>
        <p className="text-muted-foreground mt-2">
          Complete reference for all QR App API endpoints. Base URL: <code className="bg-muted px-1 rounded">/api/v1</code>
        </p>
      </div>

      {/* Quick Stats */}
      <div className="grid gap-4 sm:grid-cols-3 mb-8">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Code className="h-5 w-5 text-primary" />
              <span className="text-2xl font-bold">
                {modules.reduce((acc, m) => acc + m.endpoints.length, 0)}
              </span>
              <span className="text-sm text-muted-foreground">Endpoints</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-yellow-500" />
              <span className="text-2xl font-bold">{modules.length}</span>
              <span className="text-sm text-muted-foreground">Modules</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-green-500" />
              <span className="text-2xl font-bold">3</span>
              <span className="text-sm text-muted-foreground">User Types</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Modules */}
      <div className="space-y-6">
        {modules.map((module) => (
          <Card key={module.title} className="overflow-hidden">
            <CardHeader className="bg-muted/50">
              <CardTitle className="flex items-center gap-2 text-lg">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <module.icon className="h-4 w-4 text-primary" />
                </div>
                {module.title}
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {module.description}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="space-y-1">
                {module.endpoints.map((endpoint, idx) => (
                  <EndpointRow key={`${module.title}-${idx}-${endpoint.path}`} endpoint={endpoint} />
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
