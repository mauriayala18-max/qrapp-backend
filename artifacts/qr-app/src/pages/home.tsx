import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  QrCode,
  Utensils,
  Bell,
  CreditCard,
  Calendar,
  Star,
  Shield,
  TrendingUp,
  Zap,
  ArrowRight,
  CheckCircle,
  LayoutDashboard,
  BookOpen,
} from "lucide-react";

const features = [
  {
    icon: Utensils,
    title: "Digital Menu",
    description: "Customers scan QR codes to view your digital menu and place orders instantly.",
  },
  {
    icon: Bell,
    title: "Waiter Calls",
    description: "One-tap waiter calling system with real-time notifications to staff.",
  },
  {
    icon: CreditCard,
    title: "Secure Payments",
    description: "Integrated payment processing with support for multiple payment methods.",
  },
  {
    icon: Calendar,
    title: "Reservations",
    description: "Easy table booking and reservation management system.",
  },
  {
    icon: Star,
    title: "Ratings & Reviews",
    description: "Collect customer feedback and ratings to improve your service.",
  },
  {
    icon: Shield,
    title: "Admin Panel",
    description: "Powerful restaurant management panel with analytics and controls.",
  },
  {
    icon: TrendingUp,
    title: "Loyalty Points",
    description: "Reward your customers with points and keep them coming back.",
  },
  {
    icon: Zap,
    title: "Promotions",
    description: "Create coupons and promotional campaigns to boost sales.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden py-20 lg:py-32">
        <div className="container mx-auto px-4 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border bg-muted px-3 py-1 text-sm mb-6">
            <Zap className="h-4 w-4 text-yellow-500" />
            <span>Restaurant Platform</span>
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl mb-6">
            QR Code Restaurant
            <br />
            <span className="text-primary">Management Platform</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-8">
            A complete digital solution for modern restaurants. Let customers scan, order, pay,
            and rate — all from their phone.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/dashboard">
              <Button size="lg" className="gap-2">
                <LayoutDashboard className="h-5 w-5" />
                View Dashboard
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link href="/api-docs">
              <Button size="lg" variant="outline" className="gap-2">
                <BookOpen className="h-5 w-5" />
                API Documentation
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 bg-muted/50">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Everything You Need</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              A comprehensive platform built for restaurants, from QR menus to payment processing.
            </p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <Card key={feature.title} className="hover-elevate">
                <CardHeader className="pb-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-2">
                    <feature.icon className="h-5 w-5 text-primary" />
                  </div>
                  <CardTitle className="text-lg">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* API Status */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                Backend API Ready
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground mb-4">
                The API server is running with all modules active. Check the dashboard for real-time
                status or explore the API documentation.
              </p>
              <div className="flex flex-wrap gap-2">
                {["Auth", "Orders", "Menu", "Payments", "Reservations", "Ratings", "Notifications", "Panel", "Admin"].map(
                  (mod) => (
                    <span
                      key={mod}
                      className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium bg-primary/10 text-primary"
                    >
                      {mod}
                    </span>
                  )
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
